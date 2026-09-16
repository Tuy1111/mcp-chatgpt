// Tool implementations for the Windows code agent. Argument shapes match what
// the chatgpt-code-mcp gateway (v0.1.0) forwards over the agent socket, NOT the
// newer standalone server. Every path goes through the vendored sandbox.
import { createHash, randomBytes } from 'node:crypto';
import { readFile, readdir, writeFile, rename, rm, mkdir, unlink, lstat, copyFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import {
  assertRegularFile, isAllowed, isTraversableDir, resolvePath, discoverWorkspaces, SandboxError
} from './sandbox.mjs';

const MAX_ENTRIES = 500;
const MAX_SEARCH_HITS = 200;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function exists(abs) {
  try { await lstat(abs); return true; }
  catch (err) { if (err.code === 'ENOENT') return false; throw err; }
}
async function writeAtomic(abs, content) {
  const tmp = `${abs}.${randomBytes(6).toString('hex')}.tmp`;
  try { await writeFile(tmp, content, 'utf8'); await rename(tmp, abs); }
  catch (err) { await rm(tmp, { force: true }); throw err; }
}
function countOccurrences(hay, needle) {
  let c = 0;
  for (let i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) c += 1;
  return c;
}

// A registry that re-discovers workspaces on every call so files added on disk
// show up without restarting the agent.
export class Registry {
  constructor(roots) { this.roots = roots; }
  async list() {
    const { workspaces, problems } = await discoverWorkspaces(this.roots);
    this.problems = problems;
    return workspaces;
  }
  async get(name) {
    const workspaces = await this.list();
    if (workspaces.length === 0) throw new SandboxError('INVALID', 'no workspaces found under configured roots');
    if (name === undefined || name === '') {
      if (workspaces.length === 1) return workspaces[0];
      throw new SandboxError('INVALID', `workspace is required; choose one of: ${workspaces.map((w) => w.name).join(', ')}`);
    }
    const ws = workspaces.find((w) => w.name === name);
    if (!ws) throw new SandboxError('INVALID', `unknown workspace "${name}"; have: ${workspaces.map((w) => w.name).join(', ')}`);
    return ws;
  }
}

function runGit(cwd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e) }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

// test_run: `command` is a KEY into the workspace's commands map. The value is
// split into argv and spawned with shell:false — no string interpolation path.
function runCommand(cwd, argv, timeoutMs) {
  return new Promise((resolve) => {
    const [cmd, ...rest] = argv;
    const child = spawn(cmd, rest, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; if (out.length > 200_000) out = out.slice(-200_000); });
    child.stderr.on('data', (d) => { err += d; if (err.length > 200_000) err = err.slice(-200_000); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: '', stderr: String(e), timedOut }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err, timedOut }); });
  });
}

export function makeTools(registry) {
  return {
    async workspaces_list() {
      const workspaces = await registry.list();
      return {
        workspaces: workspaces.map((w) => ({
          name: w.name, root: w.root, writable: w.writable,
          allowedPaths: w.allowedPaths, commands: Object.keys(w.commands), maxFileBytes: w.maxFileBytes
        })),
        problems: registry.problems ?? []
      };
    },

    async directory_list(a) {
      const ws = await registry.get(a.workspace);
      const target = await resolvePath(ws, a.path ?? '.', { directory: true });
      const entries = [];
      let truncated = false;
      const dirents = await readdir(target.abs, { withFileTypes: true });
      dirents.sort((x, y) => x.name.localeCompare(y.name));
      for (const d of dirents) {
        if (entries.length >= MAX_ENTRIES) { truncated = true; break; }
        if (d.name.startsWith('.')) continue;
        const childRel = target.rel === '' ? d.name : `${target.rel}/${d.name}`;
        const childAbs = path.join(target.abs, d.name);
        if (d.isSymbolicLink()) {
          if (isAllowed(ws, childRel) || isTraversableDir(ws, childRel)) entries.push({ path: childRel, type: 'symlink' });
        } else if (d.isDirectory()) {
          if (isTraversableDir(ws, childRel)) entries.push({ path: childRel, type: 'dir' });
        } else if (d.isFile() && isAllowed(ws, childRel)) {
          const info = await lstat(childAbs);
          entries.push({ path: childRel, type: 'file', size: info.size });
        }
      }
      return { workspace: ws.name, path: target.rel === '' ? '.' : target.rel, entries, truncated };
    },

    async file_read(a) {
      const ws = await registry.get(a.workspace);
      const target = await resolvePath(ws, a.path);
      const bytes = await assertRegularFile(target);
      const buf = await readFile(target.abs);
      const hash = sha256(buf);
      if (buf.includes(0)) return { binary: true, workspace: ws.name, path: target.rel, bytes, sha256: hash, note: 'contains NUL bytes; contents omitted' };
      const lines = buf.toString('utf8').split('\n');
      return { workspace: ws.name, path: target.rel, sha256: hash, bytes, totalLines: lines.length, content: buf.toString('utf8') };
    },

    async code_search(a) {
      const ws = await registry.get(a.workspace);
      const query = String(a.query ?? '');
      if (!query) throw new SandboxError('INVALID', 'query is required');
      const hits = [];
      let truncated = false;
      const walk = async (dirAbs, dirRel) => {
        if (truncated) return;
        let dirents;
        try { dirents = await readdir(dirAbs, { withFileTypes: true }); } catch { return; }
        for (const d of dirents) {
          if (truncated) return;
          if (d.name.startsWith('.')) continue;
          const childRel = dirRel === '' ? d.name : `${dirRel}/${d.name}`;
          const childAbs = path.join(dirAbs, d.name);
          if (d.isDirectory()) { if (isTraversableDir(ws, childRel)) await walk(childAbs, childRel); continue; }
          if (!d.isFile() || !isAllowed(ws, childRel)) continue;
          let info; try { info = await lstat(childAbs); } catch { continue; }
          if (info.size > ws.maxFileBytes) continue;
          let buf; try { buf = await readFile(childAbs); } catch { continue; }
          if (buf.includes(0)) continue;
          const fileLines = buf.toString('utf8').split('\n');
          for (let i = 0; i < fileLines.length; i += 1) {
            if (fileLines[i].includes(query)) {
              hits.push({ path: childRel, line: i + 1, text: fileLines[i].slice(0, 400) });
              if (hits.length >= MAX_SEARCH_HITS) { truncated = true; break; }
            }
          }
        }
      };
      await walk(ws.root, '');
      return { workspace: ws.name, query, hits, truncated };
    },

    async file_apply_patch(a) {
      const ws = await registry.get(a.workspace);
      const target = await resolvePath(ws, a.path, { write: true });
      await assertRegularFile(target);
      const buf = await readFile(target.abs);
      const actual = sha256(buf);
      const expected = String(a.expectedSha256 ?? '').trim().toLowerCase();
      if (actual !== expected) throw new SandboxError('CONFLICT', `file changed on disk, sha256 is ${actual}, re-read before patching`);
      if (buf.includes(0)) throw new SandboxError('BINARY', `${target.rel} contains NUL bytes; refusing to patch`);
      const oldText = String(a.oldText ?? '');
      const newText = String(a.newText ?? '');
      if (!oldText) throw new SandboxError('INVALID', 'oldText is required');
      let text = buf.toString('utf8');
      const count = countOccurrences(text, oldText);
      if (count === 0) throw new SandboxError('NO_MATCH', 'oldText not found');
      if (count > 1) throw new SandboxError('AMBIGUOUS', `oldText matches ${count} times; include more context`);
      text = text.replace(oldText, () => newText);
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes > ws.maxFileBytes) throw new SandboxError('TOO_LARGE', `patched file is ${bytes} bytes, over the ${ws.maxFileBytes} byte limit`);
      await writeAtomic(target.abs, text);
      return { workspace: ws.name, path: target.rel, sha256: sha256(text), bytes };
    },

    async file_create(a) {
      const ws = await registry.get(a.workspace);
      const target = await resolvePath(ws, a.path, { write: true });
      const content = String(a.content ?? '');
      const bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > ws.maxFileBytes) throw new SandboxError('TOO_LARGE', `content is ${bytes} bytes, over the ${ws.maxFileBytes} byte limit`);
      if (await exists(target.abs)) {
        const current = sha256(await readFile(target.abs));
        throw new SandboxError('EXISTS', `${target.rel} already exists (sha256 ${current}); use file_apply_patch`);
      }
      await mkdir(path.dirname(target.abs), { recursive: true });
      await writeAtomic(target.abs, content);
      return { workspace: ws.name, path: target.rel, bytes, sha256: sha256(content), created: true };
    },

    async file_delete(a) {
      const ws = await registry.get(a.workspace);
      const target = await resolvePath(ws, a.path, { write: true });
      const bytes = await assertRegularFile(target);
      const hash = sha256(await readFile(target.abs));
      await unlink(target.abs);
      return { workspace: ws.name, path: target.rel, deleted: true, sha256: hash, bytes };
    },

    async file_move(a) {
      const ws = await registry.get(a.workspace);
      const src = await resolvePath(ws, a.path, { write: true });
      const dest = await resolvePath(ws, a.destination, { write: true });
      if (!(await exists(src.abs))) throw new SandboxError('NOT_FOUND', `${src.rel} does not exist`);
      if (await exists(dest.abs)) throw new SandboxError('EXISTS', `${dest.rel} already exists`);
      await mkdir(path.dirname(dest.abs), { recursive: true });
      try { await rename(src.abs, dest.abs); }
      catch (err) { if (err.code !== 'EXDEV') throw err; await copyFile(src.abs, dest.abs); await unlink(src.abs); }
      return { workspace: ws.name, from: src.rel, to: dest.rel, moved: true };
    },

    async git_status(a) {
      const ws = await registry.get(a.workspace);
      const r = await runGit(ws.root, ['status', '--porcelain=v1', '-b']);
      return { workspace: ws.name, ...r };
    },

    async git_diff(a) {
      const ws = await registry.get(a.workspace);
      const r = await runGit(ws.root, ['diff']);
      return { workspace: ws.name, ...r };
    },

    async test_run(a) {
      const ws = await registry.get(a.workspace);
      const key = String(a.command ?? '');
      const cmdString = ws.commands[key];
      if (!cmdString) throw new SandboxError('INVALID', `unknown command "${key}"; allowed: ${Object.keys(ws.commands).join(', ') || '(none)'}`);
      const argv = cmdString.split(/\s+/).filter(Boolean);
      if (argv.length === 0) throw new SandboxError('INVALID', `command "${key}" is empty`);
      const r = await runCommand(ws.root, argv, ws.commandTimeoutMs);
      return { workspace: ws.name, command: key, argv, ...r };
    }
  };
}
