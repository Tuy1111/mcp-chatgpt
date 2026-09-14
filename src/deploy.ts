import { spawn } from 'node:child_process';
import path from 'node:path';

/** Per-step log budget. Failures live at the end of a log, so the tail is kept. */
const MAX_STEP_CHARS = 8_000;
/** Telegram budgets for `formatDeployResult`. */
const MAX_MESSAGE_CHARS = 3_500;
const MAX_FAILURE_OUTPUT_CHARS = 1_500;
/** Metadata probes are cheap and never deserve the whole deploy budget. */
const PROBE_TIMEOUT_MS = 30_000;

const DEFAULT_SERVICES = 'mcp';
const DEFAULT_TIMEOUT_MS = 900_000;

/**
 * Service names are spliced into argv verbatim, so nothing shell-like,
 * whitespace-bearing or flag-shaped may pass.
 */
const SERVICE_NAME = /^[a-zA-Z0-9_.-]+$/;

export interface DeployConfig {
  repoDir: string;
  composeFile: string | null;
  services: string[];
  timeoutMs: number;
  enabled: boolean;
}

export function loadDeployConfig(env: NodeJS.ProcessEnv): DeployConfig {
  const rawServices = env.DEPLOY_SERVICES?.trim();
  const services = (rawServices === undefined || rawServices === '' ? DEFAULT_SERVICES : rawServices)
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
  for (const name of services) {
    // A leading dash would reach `docker compose build` as a flag, not a service.
    if (!SERVICE_NAME.test(name) || name.startsWith('-')) {
      throw new Error(`DEPLOY_SERVICES: invalid service name ${JSON.stringify(name)}`);
    }
  }
  if (services.length === 0) throw new Error('DEPLOY_SERVICES lists no service');

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  const rawTimeout = env.DEPLOY_TIMEOUT_MS?.trim();
  if (rawTimeout !== undefined && rawTimeout !== '') {
    timeoutMs = Number(rawTimeout);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`DEPLOY_TIMEOUT_MS must be a positive integer, got ${JSON.stringify(rawTimeout)}`);
    }
  }

  const repoDir = env.DEPLOY_REPO_DIR?.trim();
  const composeFile = env.DEPLOY_COMPOSE_FILE?.trim();

  return {
    repoDir: path.resolve(repoDir === undefined || repoDir === '' ? process.cwd() : repoDir),
    composeFile: composeFile === undefined || composeFile === '' ? null : composeFile,
    services,
    timeoutMs,
    // Fail closed. Every other tool is confined by the path sandbox; this one
    // runs git and docker on the host, so it stays off until explicitly armed.
    enabled: env.DEPLOY_ENABLED?.trim().toLowerCase() === 'true'
  };
}

export interface DeployStep {
  name: string;
  argv: string[];
  exitCode: number | null;
  durationMs: number;
  output: string;
}

export interface DeployResult {
  ok: boolean;
  steps: DeployStep[];
  commitBefore: string | null;
  commitAfter: string | null;
}

/** Appends a trailing note without gluing it to the last captured line. */
function appendNote(output: string, note: string): string {
  if (output === '') return `${note}\n`;
  return output.endsWith('\n') ? `${output}${note}\n` : `${output}\n${note}\n`;
}

/** A missing binary must read as a failed step, never as a thrown deploy. */
function spawnFailure(err: unknown): string {
  if (!(err instanceof Error)) return `spawn failed: unknown ${String(err)}`;
  const code = 'code' in err && typeof err.code === 'string' ? err.code : 'unknown';
  return `spawn failed: ${code} ${err.message}`;
}

interface RunOutcome {
  exitCode: number | null;
  durationMs: number;
  output: string;
}

/**
 * Runs one argv with no shell, no stdin and no prompts, merging both output
 * streams into a single tail-capped log. Never rejects: a step that could not
 * start reports `exitCode: null` with the spawn error in its output.
 */
function runProcess(argv: string[], cwd: string, timeoutMs: number): Promise<RunOutcome> {
  const [file, ...args] = argv as [string, ...string[]];
  // Executor form rather than Promise.withResolvers: tsconfig targets ES2022.
  return new Promise<RunOutcome>((resolve) => {
    const started = Date.now();
    let buf = '';
    let settled = false;
    const push = (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_STEP_CHARS * 2) buf = buf.slice(-MAX_STEP_CHARS);
    };
    const finish = (exitCode: number | null, note: string | null) => {
      if (settled) return;
      settled = true;
      const text = note === null ? buf : appendNote(buf, note);
      resolve({
        exitCode,
        durationMs: Date.now() - started,
        output: text.length > MAX_STEP_CHARS ? text.slice(-MAX_STEP_CHARS) : text
      });
    };

    try {
      const child = spawn(file, args, {
        cwd,
        shell: false,
        windowsHide: true,
        // No stdin: a command that waits for input must die, not hang the bot.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          DOCKER_CLI_HINTS: 'false',
          NO_COLOR: '1'
        }
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', push);
      child.stderr.on('data', push);
      child.on('error', (err) => {
        clearTimeout(timer);
        finish(null, spawnFailure(err));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) finish(null, `[timed out after ${timeoutMs}ms]`);
        else finish(code, null);
      });
    } catch (err) {
      finish(null, spawnFailure(err));
    }
  });
}

/**
 * A bind-mounted checkout is usually owned by a different uid than the process
 * running git, and git then refuses the repo with "dubious ownership". The
 * operator chose this directory explicitly via DEPLOY_REPO_DIR, so trust it —
 * but scope the exception to exactly that path rather than the `*` wildcard,
 * which would trust every repo the process can reach.
 */
function gitArgv(repoDir: string, ...args: string[]): string[] {
  return ['git', '-c', `safe.directory=${repoDir}`, ...args];
}

/** Reads `git rev-parse --short HEAD`, or null when the repo cannot answer. */
async function readCommit(repoDir: string, deadline: number): Promise<string | null> {
  const budget = Math.max(1, Math.min(PROBE_TIMEOUT_MS, deadline - Date.now()));
  const outcome = await runProcess(gitArgv(repoDir, 'rev-parse', '--short', 'HEAD'), repoDir, budget);
  if (outcome.exitCode !== 0) return null;
  const hash = outcome.output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{4,40}$/.test(line));
  return hash.length === 0 ? null : hash[hash.length - 1];
}

/**
 * `git pull --ff-only` then `docker compose build`/`up -d`, stopping at the
 * first step that does not exit 0. Every failure mode — disabled, wrong
 * directory, missing binary, timeout — comes back as a `DeployResult`.
 */
export async function runDeploy(
  cfg: DeployConfig,
  onProgress: (note: string) => void
): Promise<DeployResult> {
  if (!cfg.enabled) {
    return {
      ok: false,
      steps: [
        {
          name: 'disabled',
          argv: [],
          exitCode: null,
          durationMs: 0,
          output: 'deploy is disabled: DEPLOY_ENABLED=false'
        }
      ],
      commitBefore: null,
      commitAfter: null
    };
  }

  const compose = cfg.composeFile === null ? [] : ['-f', cfg.composeFile];
  const plan: { name: string; argv: string[] }[] = [
    { name: 'preflight', argv: gitArgv(cfg.repoDir, 'rev-parse', '--is-inside-work-tree') },
    { name: 'git pull', argv: gitArgv(cfg.repoDir, 'pull', '--ff-only') },
    { name: 'docker compose build', argv: ['docker', 'compose', ...compose, 'build', ...cfg.services] },
    { name: 'docker compose up', argv: ['docker', 'compose', ...compose, 'up', '-d', ...cfg.services] }
  ];

  const deadline = Date.now() + cfg.timeoutMs;
  const steps: DeployStep[] = [];
  let commitBefore: string | null = null;
  let commitAfter: string | null = null;

  for (let index = 0; index < plan.length; index += 1) {
    const entry = plan[index];
    onProgress(`▶ ${entry.name}`);
    // The budget is shared: a step may use its slice of whatever time is left.
    const budget = Math.max(1, Math.ceil((deadline - Date.now()) / (plan.length - index)));
    const outcome = await runProcess(entry.argv, cfg.repoDir, budget);
    const failed = outcome.exitCode !== 0;

    steps.push({
      name: entry.name,
      argv: entry.argv,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      output:
        failed && index === 0
          ? appendNote(outcome.output, `${cfg.repoDir} is not a git work tree`)
          : outcome.output
    });

    if (failed) onProgress(`✗ ${entry.name} (exit ${outcome.exitCode ?? 'none'})`);
    else onProgress(`✓ ${entry.name} (${(outcome.durationMs / 1000).toFixed(1)}s)`);

    // The commit is read after the pull whatever the pull did, so a later
    // failure still reports where the checkout ended up.
    if (index === 0 && !failed) commitBefore = await readCommit(cfg.repoDir, deadline);
    if (index === 1) commitAfter = await readCommit(cfg.repoDir, deadline);
    if (failed) break;
  }

  return { ok: steps.every((step) => step.exitCode === 0), steps, commitBefore, commitAfter };
}

export function formatDeployResult(result: DeployResult): string {
  const lines = [result.ok ? '✅ Deploy OK' : '❌ Deploy FAILED'];
  if (result.commitBefore !== null || result.commitAfter !== null) {
    const before = result.commitBefore ?? 'unknown';
    const after = result.commitAfter ?? 'unknown';
    lines.push(before === after ? `${before} (unchanged)` : `${before} → ${after}`);
  }
  for (const step of result.steps) {
    lines.push(
      step.exitCode === 0
        ? `✓ ${step.name} (${(step.durationMs / 1000).toFixed(1)}s)`
        : `✗ ${step.name} (exit ${step.exitCode ?? 'none'})`
    );
  }

  const header = lines.join('\n');
  let text = header;
  const failed = result.steps.find((step) => step.exitCode !== 0);
  if (failed !== undefined && failed.output.trim() !== '') {
    const label = `--- ${failed.name} output ---`;
    const budget = Math.min(
      MAX_FAILURE_OUTPUT_CHARS,
      MAX_MESSAGE_CHARS - header.length - label.length - 2
    );
    if (budget > 0) text = `${header}\n${label}\n${failed.output.trimEnd().slice(-budget)}`;
  }
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS - 1)}…` : text;
}
