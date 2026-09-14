import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  HARD_BLOCKED_PATHS,
  WORKSPACE_MARKER,
  discoverWorkspaces,
  loadWorkspace
} from '../src/config.js';
import { WorkspaceRegistry } from '../src/registry.js';
import { SandboxError } from '../src/sandbox.js';

let base: string;

before(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mcp-config-')));
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

/** Creates `<base>/<rel>`, writing the workspace marker when `marker` is given. */
async function makeDir(rel: string, marker?: string): Promise<string> {
  const dir = path.join(base, rel);
  await mkdir(dir, { recursive: true });
  if (marker !== undefined) await writeFile(path.join(dir, WORKSPACE_MARKER), marker, 'utf8');
  return dir;
}

function assertConfigError(dir: string, pattern: RegExp): (err: unknown) => true {
  return (err: unknown) => {
    assert.ok(err instanceof ConfigError, `expected ConfigError, got ${String(err)}`);
    assert.equal(err.file, path.join(dir, WORKSPACE_MARKER));
    assert.match(err.message, pattern);
    return true;
  };
}

test('loadWorkspace returns null for a directory without the marker', async () => {
  const dir = await makeDir('plain');
  assert.equal(await loadWorkspace(dir), null);
});

test('loadWorkspace throws ConfigError on malformed JSON', async () => {
  const dir = await makeDir('bad-json', '{ "name": ');
  await assert.rejects(loadWorkspace(dir), assertConfigError(dir, /invalid JSON/));
});

test('loadWorkspace throws ConfigError on unknown fields', async () => {
  const dir = await makeDir('bad-field', '{"name":"x","totallyUnknown":true}');
  await assert.rejects(loadWorkspace(dir), assertConfigError(dir, /invalid config/));
});

test('loadWorkspace applies defaults for an empty config', async () => {
  const dir = await makeDir('defaults', '{}');
  const ws = await loadWorkspace(dir);
  assert.ok(ws);
  assert.equal(ws.name, path.basename(dir));
  assert.equal(ws.root, await realpath(dir));
  assert.deepEqual(ws.allowedPaths, ['**']);
  assert.ok(ws.blockedPaths.includes('node_modules/**'));
  assert.ok(ws.blockedPaths.includes('.git/**'));
  assert.deepEqual(ws.commands, {});
  assert.equal(ws.maxFileBytes, 512_000);
  assert.equal(ws.writable, true);
  assert.equal(ws.commandTimeoutMs, 120_000);
});

test('loadWorkspace merges user blockedPaths with the hard-blocked list', async () => {
  const dir = await makeDir('merged', '{"blockedPaths":["secrets/**"]}');
  const ws = await loadWorkspace(dir);
  assert.ok(ws);
  for (const glob of HARD_BLOCKED_PATHS) assert.ok(ws.blockedPaths.includes(glob), glob);
  assert.ok(ws.blockedPaths.includes('secrets/**'));
  assert.equal(ws.blockedPaths.length, HARD_BLOCKED_PATHS.length + 1);
});

test('discoverWorkspaces treats a marked root as the workspace itself', async () => {
  const dir = await makeDir('single-root', '{}');
  const { workspaces, problems } = await discoverWorkspaces([dir]);
  assert.deepEqual(problems, []);
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0]!.name, path.basename(dir));
});

test('discoverWorkspaces scans children and sorts by name', async () => {
  const root = await makeDir('pair-root');
  await makeDir('pair-root/zeta', '{}');
  await makeDir('pair-root/alpha', '{}');
  await makeDir('pair-root/not-a-workspace');
  const { workspaces, problems } = await discoverWorkspaces([root]);
  assert.deepEqual(problems, []);
  assert.deepEqual(
    workspaces.map((ws) => ws.name),
    ['alpha', 'zeta']
  );
});

test('discoverWorkspaces reports duplicate workspace names as problems', async () => {
  const root = await makeDir('dupe-root');
  await makeDir('dupe-root/one', '{"name":"same"}');
  await makeDir('dupe-root/two', '{"name":"same"}');
  const { workspaces, problems } = await discoverWorkspaces([root]);
  assert.equal(workspaces.length, 1);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!.reason, /duplicate workspace name "same"/);
});

test('discoverWorkspaces reports a missing root instead of throwing', async () => {
  const missing = path.join(base, 'does-not-exist');
  const { workspaces, problems } = await discoverWorkspaces([missing]);
  assert.deepEqual(workspaces, []);
  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.dir, missing);
});

test('registry resolves the sole workspace without a name', async () => {
  const dir = await makeDir('registry-single', '{}');
  const registry = new WorkspaceRegistry([dir]);
  await registry.refresh();
  assert.equal(registry.get().root, await realpath(dir));
  assert.equal(registry.get(path.basename(dir)).root, await realpath(dir));
});

test('registry requires a name when several workspaces exist', async () => {
  const root = await makeDir('registry-pair');
  await makeDir('registry-pair/a', '{}');
  await makeDir('registry-pair/b', '{}');
  const registry = new WorkspaceRegistry([root]);
  await registry.refresh();
  assert.equal(registry.list().length, 2);
  assert.throws(
    () => registry.get(),
    (err: unknown) => {
      assert.ok(err instanceof SandboxError);
      assert.equal(err.code, 'INVALID');
      return true;
    }
  );
  assert.throws(
    () => registry.get('nope'),
    (err: unknown) => {
      assert.ok(err instanceof SandboxError);
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    }
  );
});
