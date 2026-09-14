import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type { WorkspaceConfig } from './config.js';

export type SandboxCode =
  | 'ESCAPE' // path leaves the workspace root
  | 'BLOCKED' // matches blockedPaths
  | 'NOT_ALLOWED' // outside allowedPaths
  | 'READ_ONLY' // workspace exposed read-only
  | 'NOT_FOUND'
  | 'TOO_LARGE'
  | 'INVALID';

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxCode,
    message: string
  ) {
    super(message);
    this.name = 'SandboxError';
  }
}

/**
 * Translates a glob into an anchored regex. Supports `**`, `*`, `?` and
 * `{a,b}` alternation — the subset that path allowlists actually use.
 * `*` never crosses `/`; `**` does.
 */
function globToRegExpSource(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === '*') {
      const doubled = glob[i + 1] === '*';
      if (doubled) {
        // `a/**` and `a/**/b`: swallow the following slash so `**` can match
        // zero segments.
        if (glob[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(',');
        out += `(?:${alts.map((a) => globToRegExpSource(a)).join('|')})`;
        i = end;
        continue;
      }
    }
    out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return out;
}

const regexCache = new Map<string, RegExp>();

function globRegex(glob: string): RegExp {
  let re = regexCache.get(glob);
  if (!re) {
    // Case-insensitive: Windows and macOS paths are not case sensitive, and a
    // case-sensitive denylist would be trivially bypassable there.
    re = new RegExp(`^${globToRegExpSource(glob)}$`, 'i');
    regexCache.set(glob, re);
  }
  return re;
}

/** Every ancestor of `rel`, closest first, excluding `rel` itself. */
function ancestors(rel: string): string[] {
  const parts = rel.split('/');
  const out: string[] = [];
  for (let i = parts.length - 1; i > 0; i -= 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

function matchesAny(rel: string, globs: readonly string[]): boolean {
  return globs.some((g) => globRegex(g).test(rel));
}

/**
 * A path is blocked when it, or any directory above it, matches a blocked
 * glob. `secrets/**` therefore also hides `secrets` itself.
 */
export function isBlocked(ws: WorkspaceConfig, rel: string): boolean {
  if (matchesAny(rel, ws.blockedPaths)) return true;
  const bare = ws.blockedPaths
    .filter((g) => g.endsWith('/**'))
    .map((g) => g.slice(0, -3));
  if (bare.length > 0 && matchesAny(rel, bare)) return true;
  return ancestors(rel).some((a) => matchesAny(a, ws.blockedPaths));
}

export function isAllowed(ws: WorkspaceConfig, rel: string): boolean {
  if (rel === '') return false;
  if (isBlocked(ws, rel)) return false;
  return matchesAny(rel, ws.allowedPaths);
}

/** Segment-wise prefixes of a glob: `src/**` -> ['src', 'src/**']. */
function globPrefixes(glob: string): string[] {
  const parts = glob.split('/');
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}

/**
 * True when the directory may contain something allowed, so listings can walk
 * into it. `''` is the workspace root and is always traversable.
 */
export function isTraversableDir(ws: WorkspaceConfig, rel: string): boolean {
  if (rel === '') return true;
  if (isBlocked(ws, rel)) return false;
  return ws.allowedPaths.some((glob) =>
    globPrefixes(glob).some((prefix) => globRegex(prefix).test(rel))
  );
}

export interface ResolvedPath {
  workspace: WorkspaceConfig;
  /** POSIX-style path relative to the workspace root. */
  rel: string;
  /** Absolute path on disk. */
  abs: string;
}

function toRel(ws: WorkspaceConfig, abs: string): string {
  const rel = path.relative(ws.root, abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new SandboxError('ESCAPE', `path escapes workspace root: ${abs}`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * Resolves the realpath of `abs` without requiring it to exist: walks up to
 * the nearest existing ancestor, resolves that, then re-appends the tail. This
 * is what stops `a-symlink-to-/etc/passwd` and `new/dir/../../../x` alike.
 */
async function realpathAllowingMissing(abs: string): Promise<string> {
  const segments: string[] = [];
  let current = path.resolve(abs);
  for (;;) {
    try {
      const resolved = await realpath(current);
      return segments.length > 0 ? path.join(resolved, ...segments.reverse()) : resolved;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new SandboxError('INVALID', `cannot resolve path: ${abs}`);
      }
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

export interface ResolveOptions {
  /** Enforce `writable` and reject reads of a read-only workspace. */
  write?: boolean;
  /** Resolve as a directory: checks traversability instead of allowedPaths. */
  directory?: boolean;
  /** Skip allowlist enforcement (still blocks escapes + blockedPaths). */
  skipAllowCheck?: boolean;
}

/**
 * The single funnel every filesystem tool must go through. Rejects absolute
 * inputs, traversal, symlink escapes, blocked globs and non-allowlisted paths.
 */
export async function resolvePath(
  ws: WorkspaceConfig,
  input: string,
  opts: ResolveOptions = {}
): Promise<ResolvedPath> {
  if (typeof input !== 'string') throw new SandboxError('INVALID', 'path must be a string');
  const raw = input.trim().replace(/\\/g, '/');
  if (raw.includes('\0')) throw new SandboxError('INVALID', 'path contains NUL');
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new SandboxError('INVALID', `path must be relative to the workspace root: ${input}`);
  }
  if (opts.write && !ws.writable) {
    throw new SandboxError('READ_ONLY', `workspace "${ws.name}" is exposed read-only`);
  }

  const normalized = path.posix.normalize(raw === '' ? '.' : raw);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new SandboxError('ESCAPE', `path escapes workspace root: ${input}`);
  }

  const abs = await realpathAllowingMissing(path.resolve(ws.root, normalized));
  const rel = toRel(ws, abs);

  if (rel !== '' && isBlocked(ws, rel)) {
    throw new SandboxError('BLOCKED', `path is blocked by workspace policy: ${rel}`);
  }
  if (!opts.skipAllowCheck) {
    const ok = opts.directory ? isTraversableDir(ws, rel) : isAllowed(ws, rel);
    if (!ok) {
      throw new SandboxError(
        'NOT_ALLOWED',
        `path is outside allowedPaths of workspace "${ws.name}": ${rel || '.'}`
      );
    }
  }

  return { workspace: ws, rel, abs };
}

export async function assertRegularFile(target: ResolvedPath): Promise<number> {
  let info;
  try {
    info = await stat(target.abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SandboxError('NOT_FOUND', `file not found: ${target.rel}`);
    }
    throw err;
  }
  if (!info.isFile()) throw new SandboxError('INVALID', `not a regular file: ${target.rel}`);
  if (info.size > target.workspace.maxFileBytes) {
    throw new SandboxError(
      'TOO_LARGE',
      `file is ${info.size} bytes, over the ${target.workspace.maxFileBytes} byte limit`
    );
  }
  return info.size;
}
