import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WorkspaceConfig } from '../config.js';
import type { WorkspaceRegistry } from '../registry.js';
import { fail, guard, okJson } from '../result.js';
import { SandboxError } from '../sandbox.js';

/** Per-stream budget. Failures live at the end of a log, so the tail is kept. */
const MAX_STREAM_CHARS = 20_000;
/** Node refuses to spawn these Windows shims without a command processor. */
const WINDOWS_SHIMS = /^(pnpm|npm|npx|yarn)$/;

/**
 * Splits a configured command line into argv, honouring single and double
 * quotes. Deliberately understands nothing else: no globbing, no variables,
 * no operators — the string never reaches a shell.
 */
function parseArgv(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current !== '') {
        argv.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += ch;
    started = true;
  }
  if (quote !== null) throw new SandboxError('INVALID', `unbalanced quote in command: ${command}`);
  if (started || current !== '') argv.push(current);
  if (argv.length === 0) throw new SandboxError('INVALID', 'command is empty');
  return argv;
}

async function findOnPath(file: string): Promise<string | null> {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue;
    const candidate = path.join(dir, file);
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

interface Launch {
  file: string;
  args: string[];
  /** argv as executed, for the caller to see what actually ran. */
  effective: string[];
  verbatim: boolean;
}

/**
 * `pnpm`/`npm`/`npx`/`yarn` are `.cmd` shims on Windows, and since the
 * CVE-2024-27980 fix Node rejects batch files unless a command processor runs
 * them. Route those through `cmd.exe` with hand-quoted arguments; everything
 * else — and every other platform — is spawned directly with no shell at all.
 */
async function planLaunch(argv: string[]): Promise<Launch> {
  const [file, ...rest] = argv as [string, ...string[]];
  if (process.platform !== 'win32' || !WINDOWS_SHIMS.test(file)) {
    return { file, args: rest, effective: argv, verbatim: false };
  }
  const shim = await findOnPath(`${file}.cmd`);
  if (shim === null) return { file, args: rest, effective: argv, verbatim: false };

  const line = [shim, ...rest]
    .map((arg) => (/[\s"^&|<>()]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg))
    .join(' ');
  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/c', `"${line}"`],
    effective: [shim, ...rest],
    verbatim: true
  };
}

/** Rolling tail buffer: never holds more than twice the budget in memory. */
function tailSink(): { push: (chunk: string) => void; value: () => string } {
  let buf = '';
  return {
    push: (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_STREAM_CHARS * 2) buf = buf.slice(-MAX_STREAM_CHARS);
    },
    value: () =>
      buf.length <= MAX_STREAM_CHARS
        ? buf
        : `[…${buf.length - MAX_STREAM_CHARS} earlier characters omitted]\n${buf.slice(-MAX_STREAM_CHARS)}`
  };
}

interface RunOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

function runCommand(ws: WorkspaceConfig, launch: Launch, timeoutMs: number): Promise<RunOutcome> {
  // Executor form rather than Promise.withResolvers: tsconfig targets ES2022.
  return new Promise<RunOutcome>((resolve, reject) => {
    const started = Date.now();
    const child = spawn(launch.file, launch.args, {
      cwd: ws.root,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: launch.verbatim,
      // No stdin: a command that reads input must fail fast, not hang.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' }
    });
    const stdout = tailSink();
    const stderr = tailSink();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', stdout.push);
    child.stderr.on('data', stderr.push);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        stdout: stdout.value(),
        stderr: stderr.value()
      });
    });
  });
}

export function registerExecTools(server: McpServer, registry: WorkspaceRegistry): void {
  server.registerTool(
    'commands_list',
    {
      title: 'List runnable commands',
      description:
        'The command whitelist declared in the workspace .code-agent.json. Only these keys can be executed by test_run.',
      inputSchema: { workspace: z.string().optional() },
      annotations: { readOnlyHint: true }
    },
    guard(async ({ workspace }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      return okJson({ workspace: ws.name, commands: ws.commands });
    })
  );

  server.registerTool(
    'test_run',
    {
      title: 'Run a whitelisted command',
      description:
        'Run one command by its key in the workspace command whitelist. A non-zero exit code is returned as data, not as an error, so the output can be read.',
      inputSchema: {
        workspace: z.string().optional(),
        command: z.string().min(1),
        timeoutMs: z.number().int().min(1_000).max(3_600_000).optional()
      },
      annotations: { readOnlyHint: false }
    },
    guard(async ({ workspace, command, timeoutMs }) => {
      await registry.ensureFresh();
      const ws = registry.get(workspace);
      const line = ws.commands[command];
      if (line === undefined) {
        const available = Object.keys(ws.commands).join(', ') || '<none>';
        return fail(
          `NOT_WHITELISTED: "${command}" is not in .code-agent.json commands; available: ${available}`
        );
      }

      const launch = await planLaunch(parseArgv(line));
      const outcome = await runCommand(
        ws,
        launch,
        Math.min(timeoutMs ?? ws.commandTimeoutMs, ws.commandTimeoutMs)
      );
      return okJson({ workspace: ws.name, command, argv: launch.effective, ...outcome });
    })
  );
}
