import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceConfig } from '../config.js';
import type { WorkspaceRegistry } from '../registry.js';
import { fail, guard, ok, okJson } from '../result.js';
import { SandboxError, isAllowed, isTraversableDir, resolvePath } from '../sandbox.js';

/** git is only ever asked local, non-interactive questions, so 30s is generous. */
const GIT_TIMEOUT_MS = 30_000;

interface GitRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runGit(ws: WorkspaceConfig, args: string[]): Promise<GitRun> {
  // Executor form rather than Promise.withResolvers: tsconfig targets ES2022.
  return new Promise<GitRun>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: ws.root,
      shell: false,
      windowsHide: true,
      // No stdin: git must never block waiting on a prompt.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_PAGER: 'cat',
        GIT_CONFIG_NOSYSTEM: '1'
      }
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), GIT_TIMEOUT_MS);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error('git is not installed or not on PATH')
          : err
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** Returns an error message when the workspace root is not a git work tree. */
async function repoProblem(ws: WorkspaceConfig): Promise<string | null> {
  const probe = await runGit(ws, ['rev-parse', '--is-inside-work-tree']);
  if (probe.code === 0 && probe.stdout.trim() === 'true') return null;
  return `NOT_A_REPO: workspace "${ws.name}" (${ws.root}) is not inside a git work tree`;
}

/**
 * A pathspec may name a file or a directory, so it passes when either the
 * allowlist or the traversal check accepts it.
 */
async function resolvePathspec(ws: WorkspaceConfig, input: string): Promise<string> {
  const target = await resolvePath(ws, input, { skipAllowCheck: true });
  if (!isAllowed(ws, target.rel) && !isTraversableDir(ws, target.rel)) {
    throw new SandboxError(
      'NOT_ALLOWED',
      `path is outside allowedPaths of workspace "${ws.name}": ${target.rel || '.'}`
    );
  }
  return target.rel;
}

interface StatusEntry {
  status: string;
  path: string;
}

interface StatusReport {
  branch: string;
  ahead: number;
  behind: number;
  files: StatusEntry[];
  hiddenCount: number;
  clean: boolean;
}

function parseStatus(ws: WorkspaceConfig, stdout: string): StatusReport {
  let branch = '(unknown)';
  let ahead = 0;
  let behind = 0;
  const files: StatusEntry[] = [];
  let hiddenCount = 0;

  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    if (line.startsWith('## ')) {
      const info = line.slice(3);
      const head = info.split('...')[0]!.split(' ')[0]!;
      branch = head.startsWith('No') ? info.replace(/^No commits yet on /, '') : head;
      const tracking = /\[(.+)]$/.exec(info);
      if (tracking !== null) {
        const a = /ahead (\d+)/.exec(tracking[1]!);
        const b = /behind (\d+)/.exec(tracking[1]!);
        if (a !== null) ahead = Number(a[1]);
        if (b !== null) behind = Number(b[1]);
      }
      continue;
    }
    const raw = line.slice(3);
    const arrow = raw.indexOf(' -> ');
    const rel = (arrow >= 0 ? raw.slice(arrow + 4) : raw).replace(/^"(.*)"$/, '$1');
    // The allowlist governs git output too: a hidden file stays hidden.
    if (!isAllowed(ws, rel)) {
      hiddenCount += 1;
      continue;
    }
    files.push({ status: line.slice(0, 2), path: rel });
  }

  return {
    branch,
    ahead,
    behind,
    files,
    hiddenCount,
    clean: files.length === 0 && hiddenCount === 0
  };
}

export function registerGitTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description:
        'Branch, ahead/behind counts and the working-tree changes of a workspace. Paths hidden by workspace policy are reported only as a count.',
      inputSchema: { workspace: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const problem = await repoProblem(ws);
      if (problem !== null) return fail(problem);

      const res = await runGit(ws, ['status', '--porcelain=v1', '-b', '--untracked-files=all']);
      if (res.code !== 0) return fail(`GIT_FAILED: git status exited ${res.code}: ${res.stderr.trim()}`);
      return okJson({ workspace: ws.name, ...parseStatus(ws, res.stdout) });
    })
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description:
        'Unified diff of the working tree (or the index with staged=true), optionally narrowed to one path and capped to maxLines.',
      inputSchema: {
        workspace: z.string().optional(),
        path: z.string().optional(),
        staged: z.boolean().optional(),
        maxLines: z.number().int().min(1).max(5_000).optional()
      },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace, path: input, staged, maxLines }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const problem = await repoProblem(ws);
      if (problem !== null) return fail(problem);

      const args = ['diff', '--no-color'];
      if (staged === true) args.push('--staged');
      if (input !== undefined) args.push('--', await resolvePathspec(ws, input));

      const res = await runGit(ws, args);
      if (res.code !== 0) return fail(`GIT_FAILED: git diff exited ${res.code}: ${res.stderr.trim()}`);

      const lines = res.stdout.split('\n');
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      if (lines.length === 0) return ok('no changes');

      const limit = maxLines ?? 400;
      const shown = lines.slice(0, limit);
      const header = `# git diff (staged=${staged === true}, lines=${shown.length}/${lines.length})`;
      return ok([header, ...shown].join('\n'));
    })
  );

  server.registerTool(
    'git_log',
    {
      title: 'Git log',
      description: 'Recent commits as one line each, optionally limited to a path.',
      inputSchema: {
        workspace: z.string().optional(),
        maxCount: z.number().int().min(1).max(50).optional(),
        path: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace, maxCount, path: input }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const problem = await repoProblem(ws);
      if (problem !== null) return fail(problem);

      const args = ['log', '--oneline', '--no-color', '-n', String(maxCount ?? 10)];
      if (input !== undefined) args.push('--', await resolvePathspec(ws, input));

      const res = await runGit(ws, args);
      if (res.code !== 0) return fail(`GIT_FAILED: git log exited ${res.code}: ${res.stderr.trim()}`);
      return ok(res.stdout.trim() === '' ? 'no commits' : res.stdout.trimEnd());
    })
  );
}
