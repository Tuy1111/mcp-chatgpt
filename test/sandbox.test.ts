import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HARD_BLOCKED_PATHS, type WorkspaceConfig } from '../src/config.js';
import {
  type SandboxCode,
  SandboxError,
  assertRegularFile,
  isAllowed,
  isBlocked,
  isTraversableDir,
  resolvePath
} from '../src/sandbox.js';

const ALLOWED_PATHS = ['src/**', 'package.json', '**/*.md'];

let base: string;
let root: string;
let outsideFile: string;

before(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mcp-sandbox-')));
  root = path.join(base, 'ws');
  await mkdir(path.join(root, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(root, 'secrets'), { recursive: true });
  await mkdir(path.join(base, 'outside'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  await writeFile(path.join(root, 'package.json'), '{}\n', 'utf8');
  await writeFile(path.join(root, 'secrets', 'token.txt'), 'shh\n', 'utf8');
  outsideFile = path.join(base, 'outside', 'target.txt');
  await writeFile(outsideFile, 'outside\n', 'utf8');
});

after(async () => {
  await rm(base, { recursive: true, force: true });
});

function workspace(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    name: 'demo',
    root,
    allowedPaths: [...ALLOWED_PATHS],
    blockedPaths: [...HARD_BLOCKED_PATHS, 'secrets/**'],
    commands: {},
    maxFileBytes: 512_000,
    writable: true,
    commandTimeoutMs: 120_000,
    ...overrides
  };
}

async function rejectsWith(promise: Promise<unknown>, code: SandboxCode): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof SandboxError, `expected SandboxError, got ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

const ALLOW_CASES: [rel: string, allowed: boolean][] = [
  ['src/a.ts', true],
  ['src/deep/b.ts', true],
  ['src', false],
  ['package.json', true],
  ['other/x.ts', false],
  ['docs/readme.md', true]
];

test('isAllowed matches files against allowedPaths', () => {
  const ws = workspace();
  for (const [rel, expected] of ALLOW_CASES) assert.equal(isAllowed(ws, rel), expected, rel);
});

// `**/*.md` makes every directory a potential match, so traversal is checked
// against a narrower allowlist plus an explicit case for the wildcard.
const TRAVERSE_CASES: [rel: string, traversable: boolean][] = [
  ['', true],
  ['src', true],
  ['src/deep', true],
  ['other', false]
];

test('isTraversableDir walks only into directories that can hold allowed files', () => {
  const ws = workspace({ allowedPaths: ['src/**', 'package.json'] });
  for (const [rel, expected] of TRAVERSE_CASES) {
    assert.equal(isTraversableDir(ws, rel), expected, rel);
  }
  assert.equal(isTraversableDir(workspace(), 'other'), true, 'other under **/*.md');
});

const BLOCK_CASES: [rel: string, blocked: boolean][] = [
  ['secrets', true],
  ['secrets/a.key', true],
  ['secrets/nested/deep.txt', true],
  ['src/a.ts', false],
  ['.git/config', true],
  ['node_modules/x/y.js', true],
  ['.env', true],
  ['src/.env.local', true],
  ['a/b.pem', true],
  ['SECRETS/a.txt', true]
];

test('isBlocked covers user globs, hard blocks and their ancestors', () => {
  const ws = workspace();
  for (const [rel, expected] of BLOCK_CASES) assert.equal(isBlocked(ws, rel), expected, rel);
});

const REJECT_CASES: [input: string, code: SandboxCode][] = [
  ['/etc/passwd', 'INVALID'],
  ['C:/Windows/win.ini', 'INVALID'],
  ['../outside.txt', 'ESCAPE'],
  ['src/../../x', 'ESCAPE'],
  ['src/a\u0000.ts', 'INVALID'],
  ['secrets/token.txt', 'BLOCKED'],
  ['other/x.ts', 'NOT_ALLOWED']
];

test('resolvePath rejects unsafe inputs with the right code', async () => {
  const ws = workspace();
  for (const [input, code] of REJECT_CASES) {
    await rejectsWith(resolvePath(ws, input), code);
  }
});

test('resolvePath rejects writes to a read-only workspace', async () => {
  const ws = workspace({ writable: false });
  await rejectsWith(resolvePath(ws, 'src/a.ts', { write: true }), 'READ_ONLY');
  const readable = await resolvePath(ws, 'src/a.ts');
  assert.equal(readable.rel, 'src/a.ts');
});

const ACCEPT_CASES: [input: string, rel: string][] = [
  ['src/a.ts', 'src/a.ts'],
  ['./src/a.ts', 'src/a.ts'],
  ['src\\a.ts', 'src/a.ts'],
  ['src/new/file.ts', 'src/new/file.ts']
];

test('resolvePath normalizes accepted inputs, including paths that do not exist yet', async () => {
  const ws = workspace();
  for (const [input, rel] of ACCEPT_CASES) {
    const resolved = await resolvePath(ws, input);
    assert.equal(resolved.rel, rel, input);
    assert.equal(resolved.abs, path.join(root, ...rel.split('/')), input);
    assert.equal(resolved.workspace, ws);
  }
});

test('resolvePath follows symlinks and rejects those escaping the root', async (t) => {
  // Windows refuses file symlinks without developer mode or elevation, but
  // allows directory junctions — either one is a real escape vector.
  const attempts: [rel: string, make: () => Promise<void>][] = [
    ['src/link.ts', () => symlink(outsideFile, path.join(root, 'src', 'link.ts'), 'file')],
    [
      'src/linkdir/target.txt',
      () => symlink(path.dirname(outsideFile), path.join(root, 'src', 'linkdir'), 'junction')
    ]
  ];

  const failures: string[] = [];
  let checked = 0;
  for (const [rel, make] of attempts) {
    try {
      await make();
    } catch (err) {
      failures.push(`${rel}: ${(err as Error).message}`);
      continue;
    }
    await rejectsWith(resolvePath(workspace(), rel), 'ESCAPE');
    checked += 1;
  }

  if (checked === 0) t.skip(`no link type available on this host: ${failures.join('; ')}`);
});

test('assertRegularFile enforces existence, file kind and the size cap', async () => {
  const ws = workspace();
  await rejectsWith(assertRegularFile(await resolvePath(ws, 'src/missing.ts')), 'NOT_FOUND');
  await rejectsWith(
    assertRegularFile(await resolvePath(ws, 'src', { directory: true })),
    'INVALID'
  );

  const tiny = workspace({ maxFileBytes: 4 });
  await rejectsWith(assertRegularFile(await resolvePath(tiny, 'src/a.ts')), 'TOO_LARGE');

  const size = await assertRegularFile(await resolvePath(ws, 'src/a.ts'));
  assert.equal(size, Buffer.byteLength('export const a = 1;\n'));
});
