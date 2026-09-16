// Sandbox + workspace config, vendored from chatgpt-code-mcp (server-side logic)
// so the Windows agent enforces the exact same path safety as the reference server.
import { readFile, readdir, realpath, stat, lstat } from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_MARKER = '.code-agent.json';

// Blocked everywhere regardless of local config. A workspace can widen
// allowedPaths but can never unblock these.
export const HARD_BLOCKED_PATHS = [
  '.git/**', '.env', '.env.*', '**/.env', '**/.env.*',
  'node_modules/**', '**/node_modules/**',
  '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx',
  '**/id_rsa*', '**/id_ed25519*',
  '**/.npmrc', '**/.git-credentials', '**/.aws/**', '**/.ssh/**'
];

const DEFAULTS = { allowedPaths: ['**'], maxFileBytes: 512_000, writable: true, commandTimeoutMs: 120_000 };

export class SandboxError extends Error {
  constructor(code, message) { super(message); this.name = 'SandboxError'; this.code = code; }
}
export class ConfigError extends Error {
  constructor(message, file) { super(message); this.name = 'ConfigError'; this.file = file; }
}

// --- glob -> anchored regex (subset: ** * ? {a,b}) --------------------------
function globToRegExpSource(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      const doubled = glob[i + 1] === '*';
      if (doubled) {
        if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
        else { out += '.*'; i += 1; }
      } else { out += '[^/]*'; }
      continue;
    }
    if (ch === '?') { out += '[^/]'; continue; }
    if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        const alts = glob.slice(i + 1, end).split(',');
        out += `(?:${alts.map((a) => globToRegExpSource(a)).join('|')})`;
        i = end; continue;
      }
    }
    out += ch.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return out;
}
const regexCache = new Map();
function globRegex(glob) {
  let re = regexCache.get(glob);
  if (!re) { re = new RegExp(`^${globToRegExpSource(glob)}$`, 'i'); regexCache.set(glob, re); }
  return re;
}
function ancestors(rel) {
  const parts = rel.split('/');
  const out = [];
  for (let i = parts.length - 1; i > 0; i -= 1) out.push(parts.slice(0, i).join('/'));
  return out;
}
function matchesAny(rel, globs) { return globs.some((g) => globRegex(g).test(rel)); }

export function isBlocked(ws, rel) {
  if (matchesAny(rel, ws.blockedPaths)) return true;
  const bare = ws.blockedPaths.filter((g) => g.endsWith('/**')).map((g) => g.slice(0, -3));
  if (bare.length > 0 && matchesAny(rel, bare)) return true;
  return ancestors(rel).some((a) => matchesAny(a, ws.blockedPaths));
}
export function isAllowed(ws, rel) {
  if (rel === '') return false;
  if (isBlocked(ws, rel)) return false;
  return matchesAny(rel, ws.allowedPaths);
}
function globPrefixes(glob) {
  const parts = glob.split('/');
  const out = [];
  for (let i = 1; i <= parts.length; i += 1) out.push(parts.slice(0, i).join('/'));
  return out;
}
export function isTraversableDir(ws, rel) {
  if (rel === '') return true;
  if (isBlocked(ws, rel)) return false;
  return ws.allowedPaths.some((glob) => globPrefixes(glob).some((p) => globRegex(p).test(rel)));
}

function toRel(ws, abs) {
  const rel = path.relative(ws.root, abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new SandboxError('ESCAPE', `path escapes workspace root: ${abs}`);
  return rel.split(path.sep).join('/');
}
async function realpathAllowingMissing(abs) {
  const segments = [];
  let current = path.resolve(abs);
  for (;;) {
    try {
      const resolved = await realpath(current);
      return segments.length > 0 ? path.join(resolved, ...segments.reverse()) : resolved;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw new SandboxError('INVALID', `cannot resolve path: ${abs}`);
      segments.push(path.basename(current));
      current = parent;
    }
  }
}

export async function resolvePath(ws, input, opts = {}) {
  if (typeof input !== 'string') throw new SandboxError('INVALID', 'path must be a string');
  const raw = input.trim().replace(/\\/g, '/');
  if (raw.includes('\0')) throw new SandboxError('INVALID', 'path contains NUL');
  if (path.posix.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) throw new SandboxError('INVALID', `path must be relative to the workspace root: ${input}`);
  if (opts.write && !ws.writable) throw new SandboxError('READ_ONLY', `workspace "${ws.name}" is exposed read-only`);
  const normalized = path.posix.normalize(raw === '' ? '.' : raw);
  if (normalized === '..' || normalized.startsWith('../')) throw new SandboxError('ESCAPE', `path escapes workspace root: ${input}`);
  const abs = await realpathAllowingMissing(path.resolve(ws.root, normalized));
  const rel = toRel(ws, abs);
  if (rel !== '' && isBlocked(ws, rel)) throw new SandboxError('BLOCKED', `path is blocked by workspace policy: ${rel}`);
  if (!opts.skipAllowCheck) {
    const ok = opts.directory ? isTraversableDir(ws, rel) : isAllowed(ws, rel);
    if (!ok) throw new SandboxError('NOT_ALLOWED', `path is outside allowedPaths of workspace "${ws.name}": ${rel || '.'}`);
  }
  return { workspace: ws, rel, abs };
}

export async function assertRegularFile(target) {
  let info;
  try { info = await stat(target.abs); }
  catch (err) {
    if (err.code === 'ENOENT') throw new SandboxError('NOT_FOUND', `file not found: ${target.rel}`);
    throw err;
  }
  if (!info.isFile()) throw new SandboxError('INVALID', `not a regular file: ${target.rel}`);
  if (info.size > target.workspace.maxFileBytes) throw new SandboxError('TOO_LARGE', `file is ${info.size} bytes, over the ${target.workspace.maxFileBytes} byte limit`);
  return info.size;
}

// --- workspace config loading + discovery -----------------------------------
export async function loadWorkspace(dir) {
  const file = path.join(dir, WORKSPACE_MARKER);
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (err) { if (err.code === 'ENOENT') return null; throw new ConfigError(`cannot read ${WORKSPACE_MARKER}: ${err.message}`, file); }
  let cfg;
  try { cfg = JSON.parse(raw); }
  catch (err) { throw new ConfigError(`invalid JSON: ${err.message}`, file); }
  if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) throw new ConfigError('config must be a JSON object', file);
  const root = await realpath(dir);
  return {
    name: typeof cfg.name === 'string' && cfg.name ? cfg.name : path.basename(root),
    root,
    allowedPaths: Array.isArray(cfg.allowedPaths) ? cfg.allowedPaths : [...DEFAULTS.allowedPaths],
    blockedPaths: [...HARD_BLOCKED_PATHS, ...(Array.isArray(cfg.blockedPaths) ? cfg.blockedPaths : [])],
    commands: (cfg.commands && typeof cfg.commands === 'object') ? cfg.commands : {},
    maxFileBytes: Number.isInteger(cfg.maxFileBytes) ? cfg.maxFileBytes : DEFAULTS.maxFileBytes,
    writable: typeof cfg.writable === 'boolean' ? cfg.writable : DEFAULTS.writable,
    commandTimeoutMs: Number.isInteger(cfg.commandTimeoutMs) ? cfg.commandTimeoutMs : DEFAULTS.commandTimeoutMs
  };
}

export async function discoverWorkspaces(roots) {
  const workspaces = new Map();
  const problems = [];
  const consider = async (dir) => {
    try {
      const ws = await loadWorkspace(dir);
      if (!ws) return false;
      const existing = workspaces.get(ws.name);
      if (existing && existing.root !== ws.root) { problems.push({ dir, reason: `duplicate workspace name "${ws.name}"` }); return true; }
      workspaces.set(ws.name, ws);
      return true;
    } catch (err) { problems.push({ dir, reason: err.message }); return true; }
  };
  for (const rawRoot of roots) {
    let root;
    try {
      root = await realpath(path.resolve(rawRoot));
      if (!(await stat(root)).isDirectory()) { problems.push({ dir: rawRoot, reason: 'not a directory' }); continue; }
    } catch (err) { problems.push({ dir: rawRoot, reason: err.message }); continue; }
    if (await consider(root)) continue;
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (err) { problems.push({ dir: root, reason: err.message }); continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await consider(path.join(root, entry.name));
    }
  }
  return { workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}
