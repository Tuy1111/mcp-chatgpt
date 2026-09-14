import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { WorkspaceRegistry } from '../src/registry.js';
import { registerSearchTools } from '../src/tools/search.js';
import { registerGitTools } from '../src/tools/git.js';
import { registerExecTools } from '../src/tools/exec.js';

const NEEDLE = 'NEEDLE_ALPHA';

let root: string;
let client: Client;

interface Match {
  path: string;
  line: number;
  column: number;
  text: string;
}

function textOf(result: CallToolResult): string {
  const first = result.content[0];
  return first !== undefined && first.type === 'text' ? first.text : '';
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args })) as CallToolResult;
}

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'code-mcp-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'secrets'), { recursive: true });
  await writeFile(path.join(root, 'src', 'app.ts'), `export const marker = '${NEEDLE}';\n`, 'utf8');
  await writeFile(path.join(root, 'secrets', 'token.txt'), `${NEEDLE} do-not-leak\n`, 'utf8');
  await writeFile(
    path.join(root, '.code-agent.json'),
    JSON.stringify({
      name: 'tmpws',
      // Everything is allowed except the blocked folder: this proves the
      // policy filter, not just a narrow allowlist, hides `secrets/`.
      allowedPaths: ['**'],
      blockedPaths: ['secrets/**'],
      commands: { hello: 'node -e "console.log(\'hi\')"' },
      commandTimeoutMs: 30_000
    }),
    'utf8'
  );

  const registry = new WorkspaceRegistry([root]);
  await registry.refresh();
  const server = new McpServer({ name: 'code-tools-test', version: '0.0.0' });
  registerSearchTools(server, registry);
  registerGitTools(server, registry);
  registerExecTools(server, registry);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

after(async () => {
  await client.close();
  await rm(root, { recursive: true, force: true });
});

test('code_search finds source hits and never leaks blocked paths', async () => {
  const result = await call('code_search', { query: NEEDLE });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(textOf(result)) as {
    engine: string;
    matches: Match[];
    matchCount: number;
  };

  assert.equal(payload.engine, 'ripgrep');
  assert.ok(
    payload.matches.some((m) => m.path === 'src/app.ts' && m.text.includes(NEEDLE)),
    `expected a src/app.ts hit, got ${JSON.stringify(payload.matches)}`
  );
  assert.equal(
    payload.matches.filter((m) => m.path.startsWith('secrets/')).length,
    0,
    'blocked secrets/ must never appear in results'
  );
  assert.equal(payload.matchCount, payload.matches.length);
});

test('code_search falls back to the built-in scanner without ripgrep', async () => {
  const realPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const result = await call('code_search', { query: NEEDLE });
    const payload = JSON.parse(textOf(result)) as { engine: string; matches: Match[] };
    assert.equal(payload.engine, 'fallback');
    assert.ok(payload.matches.some((m) => m.path === 'src/app.ts'));
    assert.equal(payload.matches.filter((m) => m.path.startsWith('secrets/')).length, 0);
  } finally {
    process.env.PATH = realPath;
  }
});

test('search and fetch round-trip a citable document', async () => {
  const found = JSON.parse(textOf(await call('search', { query: NEEDLE }))) as {
    results: { id: string; title: string; url: string }[];
  };
  const hit = found.results.find((r) => r.id.startsWith('tmpws:src/app.ts#'));
  assert.ok(hit !== undefined, `no src/app.ts result in ${JSON.stringify(found.results)}`);
  assert.equal(hit.url, 'mcp://tmpws/src/app.ts#L1');

  const doc = JSON.parse(textOf(await call('fetch', { id: hit.id }))) as {
    text: string;
    metadata: { workspace: string; path: string; line: number; sha256: string };
  };
  assert.ok(doc.text.includes(NEEDLE));
  assert.equal(doc.metadata.path, 'src/app.ts');
  assert.equal(doc.metadata.line, 1);
  assert.match(doc.metadata.sha256, /^[0-9a-f]{64}$/);
});

test('commands_list exposes only the configured whitelist', async () => {
  const payload = JSON.parse(textOf(await call('commands_list'))) as {
    commands: Record<string, string>;
  };
  assert.deepEqual(Object.keys(payload.commands), ['hello']);
});

test('test_run rejects a key that is not whitelisted', async () => {
  const result = await call('test_run', { command: 'rm -rf /' });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^NOT_WHITELISTED: "rm -rf \/" is not in \.code-agent\.json/);
});

test('test_run executes a whitelisted command and reports its output', async () => {
  const result = await call('test_run', { command: 'hello' });
  assert.equal(result.isError, undefined);
  const payload = JSON.parse(textOf(result)) as {
    argv: string[];
    exitCode: number;
    timedOut: boolean;
    stdout: string;
  };
  assert.deepEqual(payload.argv, ['node', '-e', "console.log('hi')"]);
  assert.equal(payload.exitCode, 0);
  assert.equal(payload.timedOut, false);
  assert.match(payload.stdout, /hi/);
});

test('git_status reports a non-repository workspace as an error', async () => {
  const result = await call('git_status');
  assert.equal(result.isError, true);
  assert.match(textOf(result), /^NOT_A_REPO: workspace "tmpws"/);
});
