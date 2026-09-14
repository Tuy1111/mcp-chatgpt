import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceRegistry } from '../registry.js';
import { MAX_TOOL_CHARS, capText, guard, ok, okJson } from '../result.js';
import {
  SandboxError,
  assertRegularFile,
  isAllowed,
  isTraversableDir,
  resolvePath,
  type ResolvedPath
} from '../sandbox.js';

/** Matched lines are previews, not content: one screenful of context at most. */
const MAX_MATCH_CHARS = 300;
/** Cap for the ChatGPT-facing `search` tool, which spans every workspace. */
const CONNECTOR_RESULTS = 20;

export interface SearchHit {
  path: string;
  line: number;
  column: number;
  text: string;
}

interface SearchRequest {
  query: string;
  glob: string | undefined;
  maxResults: number;
  caseSensitive: boolean;
  regex: boolean;
}

interface SearchOutcome {
  engine: 'ripgrep' | 'fallback';
  hits: SearchHit[];
  truncated: boolean;
}

function clip(line: string): string {
  const trimmed = line.trimEnd();
  return trimmed.length > MAX_MATCH_CHARS ? `${trimmed.slice(0, MAX_MATCH_CHARS)}…` : trimmed;
}

/** Shape of the subset of ripgrep's `--json` stream this module consumes. */
interface RgEvent {
  type?: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: { start?: number }[];
  };
}

function rgArgs(req: SearchRequest): string[] {
  const args = [
    '--json',
    '--line-number',
    '--no-heading',
    '--max-count',
    String(req.maxResults),
    req.caseSensitive ? '--case-sensitive' : '--ignore-case'
  ];
  if (!req.regex) args.push('--fixed-strings');
  if (req.glob !== undefined) args.push('--glob', req.glob);
  // `--regexp` keeps a query starting with `-` from being read as a flag, and
  // the explicit `./` stops ripgrep from searching the child's stdin pipe.
  args.push('--regexp', req.query, './');
  return args;
}

/**
 * ripgrep knows nothing about workspace policy, so every hit is re-checked
 * against `isAllowed` before it can reach the model.
 */
function parseRgEvent(target: ResolvedPath, line: string): SearchHit | null {
  let event: RgEvent;
  try {
    event = JSON.parse(line) as RgEvent;
  } catch {
    return null;
  }
  if (event.type !== 'match') return null;
  const data = event.data;
  const found = data?.path?.text;
  if (typeof found !== 'string' || typeof data?.line_number !== 'number') return null;
  const rel = path.posix.join(target.rel, found.split(/[\\/]/).join('/'));
  if (!isAllowed(target.workspace, rel)) return null;
  return {
    path: rel,
    line: data.line_number,
    column: (data.submatches?.[0]?.start ?? 0) + 1,
    text: clip(data.lines?.text ?? '')
  };
}

/** Resolves to null when ripgrep is not installed, so the caller can fall back. */
function runRipgrep(target: ResolvedPath, req: SearchRequest): Promise<SearchOutcome | null> {
  // Executor form rather than Promise.withResolvers: tsconfig targets ES2022.
  return new Promise<SearchOutcome | null>((resolve, reject) => {
    const child = spawn('rg', rgArgs(req), {
      cwd: target.abs,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const hits: SearchHit[] = [];
    let truncated = false;
    let pending = '';
    let stderr = '';
    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') resolve(null);
      else reject(err);
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on('data', (chunk: string) => {
      pending += chunk;
      for (;;) {
        const nl = pending.indexOf('\n');
        if (nl < 0) break;
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        const hit = line === '' ? null : parseRgEvent(target, line);
        if (hit === null) continue;
        if (hits.length >= req.maxResults) {
          truncated = true;
          child.kill();
          return;
        }
        hits.push(hit);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      // 0 = matches, 1 = no matches, >1 = real failure.
      if (!truncated && code !== null && code > 1) {
        reject(new Error(`ripgrep failed (exit ${code}): ${stderr.trim() || 'no output'}`));
        return;
      }
      resolve({ engine: 'ripgrep', hits, truncated });
    });
  });
}

/**
 * Anchored matcher for the fallback walker. Supports `**`, `*` and `?`; brace
 * alternation is a ripgrep-only luxury here.
 */
function globToRegExp(glob: string): RegExp {
  let src = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        src += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else {
        src += '[^/]*';
      }
    } else if (ch === '?') {
      src += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      src += `\\${ch}`;
    } else {
      src += ch;
    }
  }
  return new RegExp(`^${src}$`);
}

/** Pure-node scan used when ripgrep is absent. Policy is enforced per entry. */
async function runFallback(target: ResolvedPath, req: SearchRequest): Promise<SearchOutcome> {
  const ws = target.workspace;
  const matcher = new RegExp(
    req.regex ? req.query : req.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    req.caseSensitive ? '' : 'i'
  );
  const globRe = req.glob === undefined ? null : globToRegExp(req.glob);
  const globOnBasename = req.glob !== undefined && !req.glob.includes('/');
  const hits: SearchHit[] = [];
  let truncated = false;
  const queue: string[] = [''];

  while (queue.length > 0 && !truncated) {
    const sub = queue.pop()!;
    let entries;
    try {
      entries = await readdir(path.join(target.abs, sub), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const local = sub === '' ? entry.name : `${sub}/${entry.name}`;
      const rel = path.posix.join(target.rel, local);
      if (entry.isDirectory()) {
        if (isTraversableDir(ws, rel)) queue.push(local);
        continue;
      }
      if (!entry.isFile() || !isAllowed(ws, rel)) continue;
      if (globRe !== null && !globRe.test(globOnBasename ? entry.name : local)) continue;

      const abs = path.join(target.abs, local);
      let buf: Buffer;
      try {
        if ((await stat(abs)).size > ws.maxFileBytes) continue;
        buf = await readFile(abs);
      } catch {
        continue;
      }
      if (buf.includes(0)) continue;

      const lines = buf.toString('utf8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const text = lines[i]!;
        const match = matcher.exec(text);
        if (match === null) continue;
        if (hits.length >= req.maxResults) {
          truncated = true;
          break;
        }
        hits.push({ path: rel, line: i + 1, column: match.index + 1, text: clip(text) });
      }
      if (truncated) break;
    }
  }
  return { engine: 'fallback', hits, truncated };
}

async function runSearch(target: ResolvedPath, req: SearchRequest): Promise<SearchOutcome> {
  return (await runRipgrep(target, req)) ?? (await runFallback(target, req));
}

/** Splits `<workspace>:<path>[#<line>]` as produced by the `search` tool. */
function parseFetchId(id: string): { workspace: string; rel: string; line: number | undefined } {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) {
    throw new SandboxError('INVALID', `id must look like "<workspace>:<path>[#<line>]": ${id}`);
  }
  let rel = id.slice(sep + 1);
  let line: number | undefined;
  const hash = rel.lastIndexOf('#');
  if (hash >= 0) {
    const parsed = Number(rel.slice(hash + 1).replace(/^L/i, ''));
    if (Number.isInteger(parsed) && parsed > 0) {
      line = parsed;
      rel = rel.slice(0, hash);
    }
  }
  return { workspace: id.slice(0, sep), rel, line };
}

export function registerSearchTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    'code_search',
    {
      title: 'Search code',
      description:
        'Search workspace files for a literal string or regex. Uses ripgrep when available and a built-in scanner otherwise; results are always filtered through the workspace allow/block policy.',
      inputSchema: {
        workspace: z.string().optional(),
        query: z.string().min(1),
        path: z.string().optional(),
        glob: z.string().optional(),
        maxResults: z.number().int().min(1).max(500).optional(),
        caseSensitive: z.boolean().optional(),
        regex: z.boolean().optional()
      },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace, query, path: dir, glob, maxResults, caseSensitive, regex }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const target = await resolvePath(ws, dir ?? '.', { directory: true });
      const outcome = await runSearch(target, {
        query,
        glob,
        maxResults: maxResults ?? 60,
        caseSensitive: caseSensitive ?? false,
        regex: regex ?? false
      });
      return okJson({
        workspace: ws.name,
        engine: outcome.engine,
        query,
        matches: outcome.hits,
        matchCount: outcome.hits.length,
        truncated: outcome.truncated
      });
    })
  );

  // `search` + `fetch` are the pair ChatGPT requires from every connector.
  server.registerTool(
    'search',
    {
      title: 'Search',
      description:
        'Search every exposed workspace for a literal string and return citable result ids for `fetch`.',
      inputSchema: { query: z.string().min(1) },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ query }) => {
      await registry.ensureFresh();
      const results: { id: string; title: string; url: string }[] = [];
      for (const ws of registry.list()) {
        if (results.length >= CONNECTOR_RESULTS) break;
        const target = await resolvePath(ws, '.', { directory: true });
        const outcome = await runSearch(target, {
          query,
          glob: undefined,
          maxResults: CONNECTOR_RESULTS - results.length,
          caseSensitive: false,
          regex: false
        });
        for (const hit of outcome.hits) {
          results.push({
            id: `${ws.name}:${hit.path}#${hit.line}`,
            title: `${hit.path}:${hit.line}`,
            url: `mcp://${ws.name}/${hit.path}#L${hit.line}`
          });
        }
      }
      return ok(JSON.stringify({ results }));
    })
  );

  server.registerTool(
    'fetch',
    {
      title: 'Fetch',
      description: 'Fetch the full text of a document returned by `search`, by result id.',
      inputSchema: { id: z.string().min(1) },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ id }) => {
      await registry.ensureFresh();
      const parsed = parseFetchId(id);
      const ws = registry.get(parsed.workspace);
      const target = await resolvePath(ws, parsed.rel);
      await assertRegularFile(target);
      const buf = await readFile(target.abs);
      // Halve the budget: the payload is JSON-escaped before the outer cap.
      const body = capText(buf.toString('utf8'), Math.floor(MAX_TOOL_CHARS / 2));
      return ok(
        JSON.stringify({
          id,
          title: `${ws.name}:${target.rel}`,
          text: body.text,
          url: `mcp://${ws.name}/${target.rel}${parsed.line === undefined ? '' : `#L${parsed.line}`}`,
          metadata: {
            workspace: ws.name,
            path: target.rel,
            ...(parsed.line === undefined ? {} : { line: parsed.line }),
            sha256: createHash('sha256').update(buf).digest('hex')
          }
        })
      );
    })
  );
}
