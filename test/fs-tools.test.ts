import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { WorkspaceRegistry } from '../src/registry.js';
import { registerFsTools } from '../src/tools/fs.js';

let root: string;
let client: Client;
let server: McpServer;

interface Call {
  isError: boolean;
  text: string;
}

async function call(name: string, args: Record<string, unknown>): Promise<Call> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as { type: string; text: string }[];
  return { isError: res.isError === true, text: content[0]!.text };
}

async function callJson(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const res = await call(name, args);
  assert.equal(res.isError, false, `expected success, got: ${res.text}`);
  return JSON.parse(res.text);
}

async function diskSha(rel: string): Promise<string> {
  return createHash('sha256').update(await readFile(path.join(root, rel))).digest('hex');
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'fs-tools-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'secrets'), { recursive: true });
  await writeFile(
    path.join(root, '.code-agent.json'),
    JSON.stringify({
      name: 'fsws',
      allowedPaths: ['src/**', 'notes/**', 'package.json'],
      blockedPaths: ['secrets/**']
    }),
    'utf8'
  );
  await writeFile(path.join(root, 'src', 'a.ts'), 'alpha\nbeta\ngamma\n', 'utf8');
  await writeFile(path.join(root, 'src', 'dup.ts'), 'x\nx\n', 'utf8');
  await writeFile(path.join(root, 'notes', 'todo.md'), '- todo\n', 'utf8');
  await writeFile(path.join(root, 'secrets', 'x.txt'), 'top secret\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), '{}\n', 'utf8');

  server = new McpServer({ name: 'fs-tools-test', version: '0.0.0' });
  registerFsTools(server, new WorkspaceRegistry([root]));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'fs-tools-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
});

after(async () => {
  await client.close();
  await server.close();
  await rm(root, { recursive: true, force: true });
});

test('registers the six filesystem tools', async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((t) => t.name).sort(),
    ['directory_list', 'file_apply_patch', 'file_create', 'file_delete', 'file_move', 'file_read']
  );
});

test('file_read returns content and the sha256 of the whole file', async () => {
  const data = await callJson('file_read', { path: 'src/a.ts' });
  assert.equal(data.content, 'alpha\nbeta\ngamma\n');
  assert.equal(data.sha256, await diskSha('src/a.ts'));
  assert.equal(data.bytes, 17);
  assert.equal(data.totalLines, 4);
});

test('file_read line range is inclusive, 1-based and clamped', async () => {
  const data = await callJson('file_read', { path: 'src/a.ts', startLine: 2, endLine: 99 });
  assert.equal(data.startLine, 2);
  assert.equal(data.endLine, 4);
  assert.equal(data.content, 'beta\ngamma\n');
  // sha256 still covers the entire file, not the slice.
  assert.equal(data.sha256, await diskSha('src/a.ts'));
});

test('file_read rejects a blocked path', async () => {
  const res = await call('file_read', { path: 'secrets/x.txt' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^BLOCKED:/);
});

test('file_read rejects traversal outside the workspace', async () => {
  const res = await call('file_read', { path: '../outside' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^ESCAPE:/);
});

test('file_read rejects a path outside allowedPaths', async () => {
  const res = await call('file_read', { path: 'package-lock.json' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^NOT_ALLOWED:/);
});

test('file_apply_patch refuses a stale sha256 and leaves the file untouched', async () => {
  const res = await call('file_apply_patch', {
    path: 'src/a.ts',
    expectedSha256: 'f'.repeat(64),
    edits: [{ oldText: 'beta', newText: 'BETA' }]
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /^CONFLICT: file changed on disk, sha256 is [0-9a-f]{64}, re-read before patching$/);
  assert.equal(await readFile(path.join(root, 'src/a.ts'), 'utf8'), 'alpha\nbeta\ngamma\n');
});

test('file_apply_patch applies edits when the sha256 matches', async () => {
  const before = await callJson('file_read', { path: 'src/a.ts' });
  const data = await callJson('file_apply_patch', {
    path: 'src/a.ts',
    expectedSha256: before.sha256.toUpperCase(),
    edits: [
      { oldText: 'beta', newText: 'BETA' },
      { oldText: 'gamma', newText: 'GAMMA' }
    ]
  });
  assert.equal(data.editsApplied, 2);
  assert.equal(data.replacements, 2);
  assert.equal(await readFile(path.join(root, 'src/a.ts'), 'utf8'), 'alpha\nBETA\nGAMMA\n');
  assert.equal(data.sha256, await diskSha('src/a.ts'));
});

test('file_apply_patch is all-or-nothing when a later edit does not match', async () => {
  const before = await callJson('file_read', { path: 'src/a.ts' });
  const res = await call('file_apply_patch', {
    path: 'src/a.ts',
    expectedSha256: before.sha256,
    edits: [
      { oldText: 'alpha', newText: 'ALPHA' },
      { oldText: 'nowhere', newText: 'x' }
    ]
  });
  assert.equal(res.isError, true);
  assert.equal(res.text, 'NO_MATCH: edit 2 oldText not found');
  assert.equal(await diskSha('src/a.ts'), before.sha256);
});

test('file_apply_patch rejects an ambiguous edit unless replaceAll is set', async () => {
  const before = await callJson('file_read', { path: 'src/dup.ts' });
  const res = await call('file_apply_patch', {
    path: 'src/dup.ts',
    expectedSha256: before.sha256,
    edits: [{ oldText: 'x', newText: 'y' }]
  });
  assert.equal(res.isError, true);
  assert.match(res.text, /^AMBIGUOUS: edit 1 oldText matches 2 times/);

  const data = await callJson('file_apply_patch', {
    path: 'src/dup.ts',
    expectedSha256: before.sha256,
    edits: [{ oldText: 'x', newText: 'y', replaceAll: true }]
  });
  assert.equal(data.replacements, 2);
  assert.equal(await readFile(path.join(root, 'src/dup.ts'), 'utf8'), 'y\ny\n');
});

test('file_create writes new files and refuses to clobber without overwrite', async () => {
  const created = await callJson('file_create', { path: 'src/deep/new.ts', content: 'hi\n' });
  assert.equal(created.created, true);
  assert.equal(created.bytes, 3);
  assert.equal(created.sha256, await diskSha('src/deep/new.ts'));

  const clash = await call('file_create', { path: 'src/deep/new.ts', content: 'other\n' });
  assert.equal(clash.isError, true);
  assert.match(clash.text, /^EXISTS: src\/deep\/new\.ts already exists \(sha256 [0-9a-f]{64}\)/);

  const overwritten = await callJson('file_create', {
    path: 'src/deep/new.ts',
    content: 'other\n',
    overwrite: true
  });
  assert.equal(overwritten.created, false);
  assert.equal(await readFile(path.join(root, 'src/deep/new.ts'), 'utf8'), 'other\n');
});

test('file_create cannot write into a blocked directory', async () => {
  const res = await call('file_create', { path: 'secrets/leak.txt', content: 'x' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^BLOCKED:/);
});

test('directory_list hides blocked and non-allowlisted entries', async () => {
  const data = await callJson('directory_list', { path: '.', depth: 2 });
  const paths: string[] = data.entries.map((e: { path: string }) => e.path);
  assert.equal(data.truncated, false);
  assert.ok(paths.includes('src'));
  assert.ok(paths.includes('src/a.ts'));
  assert.ok(paths.includes('notes/todo.md'));
  assert.ok(paths.includes('package.json'));
  assert.ok(!paths.some((p) => p.startsWith('secrets')), `secrets leaked: ${paths.join(', ')}`);
  assert.ok(!paths.includes('.code-agent.json'));

  const file = data.entries.find((e: { path: string }) => e.path === 'src/a.ts');
  assert.equal(file.type, 'file');
  assert.equal(file.size, 17);
  assert.equal(data.entries.find((e: { path: string }) => e.path === 'src').type, 'dir');
});

test('directory_list depth 1 does not descend', async () => {
  const data = await callJson('directory_list', {});
  const paths: string[] = data.entries.map((e: { path: string }) => e.path);
  assert.ok(paths.includes('src'));
  assert.ok(!paths.includes('src/a.ts'));
});

test('directory_list refuses a blocked directory', async () => {
  const res = await call('directory_list', { path: 'secrets' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^BLOCKED:/);
});

test('file_move renames within the workspace and guards the destination', async () => {
  const moved = await callJson('file_move', { from: 'src/dup.ts', to: 'notes/dup.txt' });
  assert.deepEqual([moved.from, moved.to, moved.moved], ['src/dup.ts', 'notes/dup.txt', true]);
  assert.equal(await readFile(path.join(root, 'notes/dup.txt'), 'utf8'), 'y\ny\n');

  const clash = await call('file_move', { from: 'notes/dup.txt', to: 'notes/todo.md' });
  assert.equal(clash.isError, true);
  assert.match(clash.text, /^EXISTS: notes\/todo\.md already exists/);

  const escape = await call('file_move', { from: 'notes/dup.txt', to: '../stolen.txt' });
  assert.equal(escape.isError, true);
  assert.match(escape.text, /^ESCAPE:/);
});

test('file_delete removes a regular file and reports its pre-delete hash', async () => {
  const hash = await diskSha('notes/dup.txt');
  const data = await callJson('file_delete', { path: 'notes/dup.txt' });
  assert.equal(data.deleted, true);
  assert.equal(data.sha256, hash);
  assert.equal(data.bytes, 4);
  await assert.rejects(readFile(path.join(root, 'notes/dup.txt')));
});

test('file_delete refuses a directory', async () => {
  const res = await call('file_delete', { path: 'src/deep' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^INVALID: not a regular file/);
});

test('file_read reports binary files without dumping them', async () => {
  await writeFile(path.join(root, 'src/bin.ts'), Buffer.from([0x61, 0x00, 0x62]));
  const res = await call('file_read', { path: 'src/bin.ts' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^BINARY: src\/bin\.ts contains NUL bytes \(3 bytes, sha256 [0-9a-f]{64}\)/);
});

test('unknown workspace name is rejected', async () => {
  const res = await call('file_read', { workspace: 'nope', path: 'src/a.ts' });
  assert.equal(res.isError, true);
  assert.match(res.text, /^NOT_FOUND: unknown workspace "nope"/);
});
