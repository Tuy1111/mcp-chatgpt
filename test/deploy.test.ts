import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  formatDeployResult,
  loadDeployConfig,
  runDeploy,
  type DeployConfig,
  type DeployResult
} from '../src/deploy.js';

const execFileAsync = promisify(execFile);

/**
 * These tests spawn real processes. `git` is the real binary against real
 * throwaway repositories; `docker` is a fake that PATH resolves before any
 * installed docker. On Windows, spawn() with `shell: false` refuses `.cmd`
 * shims and libuv only path-searches `.com`/`.exe`, so the fake is a copy of
 * the node binary whose behaviour is injected through NODE_OPTIONS.
 */
const SHIM_SOURCE = `
import { appendFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(1).map((arg, index) => (index === 0 ? path.basename(arg) : arg));
appendFileSync(process.env.DEPLOY_SHIM_LOG, JSON.stringify(argv) + '\\n');

const sleepMs = Number(process.env.DEPLOY_SHIM_SLEEP_MS ?? '0');
if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));

const key = argv.includes('build') ? 'DEPLOY_SHIM_BUILD_EXIT' : 'DEPLOY_SHIM_UP_EXIT';
const code = Number(process.env[key] ?? '0');
process.stdout.write('docker shim ran: ' + argv.join(' ') + '\\n');
if (code !== 0) process.stderr.write('docker shim failure marker ' + code + '\\n');
process.exit(code);
`;

let base: string;
/** Clone with an upstream branch: `git pull --ff-only` succeeds here. */
let workRepo: string;
/** Repo without a remote: `git pull --ff-only` fails here. */
let soloRepo: string;
/** Plain directory, never a git work tree. */
let plainDir: string;
let originRepo: string;
let shimDir: string;
let emptyShimDir: string;
let shimLog: string;

const savedEnv: Record<string, string | undefined> = {};

function setEnv(key: string, value: string | undefined): void {
  if (!(key in savedEnv)) savedEnv[key] = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** PATH with the fake docker first and every real docker directory removed. */
function shimmedPath(dir: string): string {
  const entries = (savedEnv.PATH ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .filter(
      (entry) =>
        entry !== '' &&
        !existsSync(path.join(entry, 'docker')) &&
        !existsSync(path.join(entry, 'docker.exe'))
    );
  return [dir, ...entries].join(path.delimiter);
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: process.env });
  return stdout.trim();
}

async function makeShimDir(name: string, withDocker: boolean): Promise<string> {
  const dir = path.join(base, name);
  await mkdir(dir, { recursive: true });
  if (!withDocker) return dir;
  const exe = path.join(dir, process.platform === 'win32' ? 'docker.exe' : 'docker');
  try {
    await symlink(process.execPath, exe, 'file');
  } catch {
    try {
      await link(process.execPath, exe);
    } catch {
      await copyFile(process.execPath, exe);
    }
  }
  return dir;
}

function config(repoDir: string, overrides: Partial<DeployConfig> = {}): DeployConfig {
  return {
    repoDir,
    composeFile: null,
    services: ['mcp'],
    timeoutMs: 60_000,
    enabled: true,
    ...overrides
  };
}

async function resetShim(): Promise<void> {
  await writeFile(shimLog, '', 'utf8');
  setEnv('DEPLOY_SHIM_BUILD_EXIT', '0');
  setEnv('DEPLOY_SHIM_UP_EXIT', '0');
  setEnv('DEPLOY_SHIM_SLEEP_MS', '0');
  setEnv('PATH', shimmedPath(shimDir));
}

/** Every fake-docker invocation, as argv arrays. */
async function shimCalls(): Promise<string[][]> {
  const raw = await readFile(shimLog, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[]);
}

before(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'mcp-deploy-')));

  // Keep git away from the developer's own configuration and repositories.
  const emptyConfig = path.join(base, 'gitconfig');
  await writeFile(emptyConfig, '', 'utf8');
  setEnv('GIT_CONFIG_GLOBAL', emptyConfig);
  setEnv('GIT_CONFIG_SYSTEM', emptyConfig);
  setEnv('GIT_CEILING_DIRECTORIES', base);
  setEnv('GIT_AUTHOR_NAME', 'Deploy Test');
  setEnv('GIT_AUTHOR_EMAIL', 'deploy@test.invalid');
  setEnv('GIT_COMMITTER_NAME', 'Deploy Test');
  setEnv('GIT_COMMITTER_EMAIL', 'deploy@test.invalid');

  originRepo = path.join(base, 'origin');
  await mkdir(originRepo, { recursive: true });
  await git(originRepo, 'init', '-b', 'main');
  await git(originRepo, 'config', 'user.email', 'deploy@test.invalid');
  await git(originRepo, 'config', 'user.name', 'Deploy Test');
  await writeFile(path.join(originRepo, 'README.md'), 'one\n', 'utf8');
  await git(originRepo, 'add', '.');
  await git(originRepo, 'commit', '-m', 'first');

  await git(base, 'clone', originRepo, 'work');
  workRepo = path.join(base, 'work');
  await git(workRepo, 'config', 'user.email', 'deploy@test.invalid');
  await git(workRepo, 'config', 'user.name', 'Deploy Test');
  // A commit the clone has not seen yet, so `git pull --ff-only` moves HEAD.
  await writeFile(path.join(originRepo, 'README.md'), 'one\ntwo\n', 'utf8');
  await git(originRepo, 'commit', '-am', 'second');

  soloRepo = path.join(base, 'solo');
  await mkdir(soloRepo, { recursive: true });
  await git(soloRepo, 'init', '-b', 'main');
  await git(soloRepo, 'config', 'user.email', 'deploy@test.invalid');
  await git(soloRepo, 'config', 'user.name', 'Deploy Test');
  await writeFile(path.join(soloRepo, 'README.md'), 'solo\n', 'utf8');
  await git(soloRepo, 'add', '.');
  await git(soloRepo, 'commit', '-m', 'solo');

  plainDir = path.join(base, 'plain');
  await mkdir(plainDir, { recursive: true });

  const shimScript = path.join(base, 'docker-shim.mjs');
  await writeFile(shimScript, SHIM_SOURCE, 'utf8');
  shimLog = path.join(base, 'docker-shim.log');
  shimDir = await makeShimDir('shim', true);
  emptyShimDir = await makeShimDir('shim-empty', false);

  setEnv('NODE_OPTIONS', `--import ${pathToFileURL(shimScript).href}`);
  setEnv('DEPLOY_SHIM_LOG', shimLog);
  await resetShim();
});

after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(base, { recursive: true, force: true });
});

test('loadDeployConfig defaults to disabled so deploy is never on by accident', () => {
  const cfg = loadDeployConfig({});
  assert.deepEqual(cfg.services, ['mcp']);
  assert.equal(cfg.composeFile, null);
  assert.equal(cfg.timeoutMs, 900_000);
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.repoDir, path.resolve(process.cwd()));
});

test('loadDeployConfig arms deploy only for an explicit true', () => {
  assert.equal(loadDeployConfig({ DEPLOY_ENABLED: 'true' }).enabled, true);
  assert.equal(loadDeployConfig({ DEPLOY_ENABLED: 'TRUE' }).enabled, true);
  assert.equal(loadDeployConfig({ DEPLOY_ENABLED: 'yes' }).enabled, false);
  assert.equal(loadDeployConfig({ DEPLOY_ENABLED: '1' }).enabled, false);
  assert.equal(loadDeployConfig({ DEPLOY_ENABLED: '' }).enabled, false);
});

test('loadDeployConfig reads every knob', () => {
  const cfg = loadDeployConfig({
    DEPLOY_ENABLED: 'false',
    DEPLOY_REPO_DIR: base,
    DEPLOY_COMPOSE_FILE: 'compose.prod.yaml',
    DEPLOY_SERVICES: ' mcp , caddy ,',
    DEPLOY_TIMEOUT_MS: '1000'
  });
  assert.equal(cfg.enabled, false);
  assert.equal(cfg.repoDir, path.resolve(base));
  assert.equal(cfg.composeFile, 'compose.prod.yaml');
  assert.deepEqual(cfg.services, ['mcp', 'caddy']);
  assert.equal(cfg.timeoutMs, 1000);
});

test('loadDeployConfig rejects service names that could smuggle argv', () => {
  assert.throws(() => loadDeployConfig({ DEPLOY_SERVICES: 'mcp;rm -rf /' }), /invalid service name/);
  assert.throws(() => loadDeployConfig({ DEPLOY_SERVICES: 'mcp,--privileged' }), /invalid service name/);
  assert.throws(() => loadDeployConfig({ DEPLOY_SERVICES: 'mcp,$(id)' }), /invalid service name/);
  assert.throws(() => loadDeployConfig({ DEPLOY_SERVICES: ',,' }), /lists no service/);
});

test('loadDeployConfig rejects a non-positive timeout', () => {
  assert.throws(() => loadDeployConfig({ DEPLOY_TIMEOUT_MS: 'soon' }), /positive integer/);
  assert.throws(() => loadDeployConfig({ DEPLOY_TIMEOUT_MS: '0' }), /positive integer/);
  assert.throws(() => loadDeployConfig({ DEPLOY_TIMEOUT_MS: '-5' }), /positive integer/);
});

test('runDeploy refuses to run when disabled, without throwing', async () => {
  await resetShim();
  const notes: string[] = [];
  const result = await runDeploy(config(workRepo, { enabled: false }), (note) => notes.push(note));

  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].name, 'disabled');
  assert.equal(result.commitBefore, null);
  assert.equal(result.commitAfter, null);
  assert.deepEqual(notes, []);
  assert.deepEqual(await shimCalls(), []);
});

test('runDeploy stops at preflight when the directory is not a work tree', async () => {
  await resetShim();
  const result = await runDeploy(config(plainDir), () => {});

  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].name, 'preflight');
  assert.notEqual(result.steps[0].exitCode, 0);
  assert.match(result.steps[0].output, /is not a git work tree/);
  assert.equal(result.commitBefore, null);
  assert.deepEqual(await shimCalls(), []);
});

test('runDeploy pulls then builds and starts the requested services', async () => {
  await resetShim();
  const notes: string[] = [];
  const result = await runDeploy(
    config(workRepo, { composeFile: 'compose.yaml', services: ['mcp', 'caddy'] }),
    (note) => notes.push(note)
  );

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2));
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['preflight', 'git pull', 'docker compose build', 'docker compose up']
  );
  assert.deepEqual(result.steps[2].argv, [
    'docker',
    'compose',
    '-f',
    'compose.yaml',
    'build',
    'mcp',
    'caddy'
  ]);
  assert.deepEqual(result.steps[3].argv, [
    'docker',
    'compose',
    '-f',
    'compose.yaml',
    'up',
    '-d',
    'mcp',
    'caddy'
  ]);

  // The fake docker really ran, with the argv the step reports.
  assert.deepEqual(await shimCalls(), [
    ['compose', '-f', 'compose.yaml', 'build', 'mcp', 'caddy'],
    ['compose', '-f', 'compose.yaml', 'up', '-d', 'mcp', 'caddy']
  ]);
  assert.match(result.steps[2].output, /docker shim ran/);

  // The clone fast-forwarded onto the commit made after it was cloned.
  assert.match(result.commitBefore ?? '', /^[0-9a-f]{4,40}$/);
  assert.match(result.commitAfter ?? '', /^[0-9a-f]{4,40}$/);
  assert.notEqual(result.commitBefore, result.commitAfter);
  assert.equal(result.commitAfter, await git(workRepo, 'rev-parse', '--short', 'HEAD'));

  assert.ok(notes.includes('▶ git pull'), notes.join(' | '));
  assert.ok(
    notes.some((note) => /^✓ docker compose up \(\d+\.\d+s\)$/.test(note)),
    notes.join(' | ')
  );

  const text = formatDeployResult(result);
  assert.match(text, /^✅ Deploy OK\n/);
  assert.match(text, /→/);
  assert.ok(text.length <= 3500);
});

test('runDeploy stops when git pull fails and never touches docker', async () => {
  await resetShim();
  const notes: string[] = [];
  const result = await runDeploy(config(soloRepo), (note) => notes.push(note));

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['preflight', 'git pull']
  );
  assert.notEqual(result.steps[1].exitCode, 0);
  assert.deepEqual(await shimCalls(), []);
  assert.ok(
    notes.some((note) => note.startsWith('✗ git pull (exit ')),
    notes.join(' | ')
  );

  // Nothing moved, so the commit line collapses to a single hash.
  assert.equal(result.commitBefore, result.commitAfter);
  const text = formatDeployResult(result);
  assert.match(text, /^❌ Deploy FAILED\n[0-9a-f]{4,40} \(unchanged\)\n/);
  assert.match(text, /--- git pull output ---/);
  assert.ok(text.length <= 3500);
});

test('runDeploy stops after a failing build and reports its output', async () => {
  await resetShim();
  setEnv('DEPLOY_SHIM_BUILD_EXIT', '3');
  const result = await runDeploy(config(workRepo), () => {});

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['preflight', 'git pull', 'docker compose build']
  );
  assert.equal(result.steps[2].exitCode, 3);
  assert.equal((await shimCalls()).length, 1);

  const text = formatDeployResult(result);
  assert.match(text, /✗ docker compose build \(exit 3\)/);
  assert.match(text, /docker shim failure marker 3/);
  assert.ok(text.length <= 3500);
});

test('runDeploy reports a missing docker binary instead of throwing', async () => {
  await resetShim();
  setEnv('PATH', shimmedPath(emptyShimDir));
  const result = await runDeploy(config(workRepo), () => {});

  assert.equal(result.ok, false);
  assert.equal(result.steps.length, 3);
  assert.equal(result.steps[2].name, 'docker compose build');
  assert.equal(result.steps[2].exitCode, null);
  assert.match(result.steps[2].output, /spawn failed: ENOENT/);
  assert.deepEqual(await shimCalls(), []);
});

// Real clock on purpose: the budget is enforced by a timer that SIGKILLs a
// real child process, so there is no injectable clock to fake here.
test('runDeploy kills a step that outlives the shared budget', async () => {
  await resetShim();
  setEnv('DEPLOY_SHIM_SLEEP_MS', '20000');
  const started = Date.now();
  const result = await runDeploy(config(workRepo, { timeoutMs: 6_000 }), () => {});

  assert.equal(result.ok, false);
  assert.equal(result.steps[2].name, 'docker compose build');
  assert.equal(result.steps[2].exitCode, null);
  assert.match(result.steps[2].output, /\[timed out after \d+ms\]/);
  assert.ok(Date.now() - started < 18_000, 'the sleeping child was not killed');
});

test('formatDeployResult keeps only the failing tail and stays under the cap', () => {
  const noisy: DeployResult = {
    ok: false,
    steps: [
      { name: 'preflight', argv: ['git'], exitCode: 0, durationMs: 120, output: 'true\n' },
      { name: 'git pull', argv: ['git', 'pull'], exitCode: 0, durationMs: 900, output: 'ok\n' },
      {
        name: 'docker compose build',
        argv: ['docker', 'compose', 'build', 'mcp'],
        exitCode: 1,
        durationMs: 4500,
        output: `${'noise\n'.repeat(4000)}THE REAL ERROR`
      }
    ],
    commitBefore: 'aaaaaaa',
    commitAfter: 'bbbbbbb'
  };

  const text = formatDeployResult(noisy);
  assert.ok(text.length <= 3500, `length ${text.length}`);
  assert.match(text, /^❌ Deploy FAILED\naaaaaaa → bbbbbbb\n/);
  assert.match(text, /THE REAL ERROR$/);
  assert.ok(!text.includes('✗ preflight'));
});
