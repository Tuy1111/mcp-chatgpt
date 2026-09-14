import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export const WORKSPACE_MARKER = '.code-agent.json';

/**
 * Patterns that are blocked in every workspace regardless of local config.
 * A workspace config can widen `allowedPaths` but can never unblock these.
 */
export const HARD_BLOCKED_PATHS: readonly string[] = [
  '.git/**',
  '.env',
  '.env.*',
  '**/.env',
  '**/.env.*',
  'node_modules/**',
  '**/node_modules/**',
  '**/*.pem',
  '**/*.key',
  '**/*.p12',
  '**/*.pfx',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/.npmrc',
  '**/.git-credentials',
  '**/.aws/**',
  '**/.ssh/**'
];

const ConfigFileSchema = z
  .object({
    name: z.string().min(1).optional(),
    allowedPaths: z.array(z.string().min(1)).optional(),
    blockedPaths: z.array(z.string().min(1)).optional(),
    commands: z.record(z.string(), z.string().min(1)).optional(),
    /** Reject reads/writes larger than this. Guards context blowups. */
    maxFileBytes: z.number().int().positive().max(50_000_000).optional(),
    /** When false the workspace is exposed read-only over MCP. */
    writable: z.boolean().optional(),
    /** Wall-clock cap for `test_run`, in milliseconds. */
    commandTimeoutMs: z.number().int().positive().max(3_600_000).optional()
  })
  .strict();

export type WorkspaceConfigFile = z.infer<typeof ConfigFileSchema>;

export interface WorkspaceConfig {
  /** Stable id used by MCP tool arguments. */
  name: string;
  /** Absolute, symlink-resolved workspace root. */
  root: string;
  allowedPaths: string[];
  blockedPaths: string[];
  commands: Record<string, string>;
  maxFileBytes: number;
  writable: boolean;
  commandTimeoutMs: number;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly file: string
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

const DEFAULTS = {
  allowedPaths: ['**'],
  maxFileBytes: 512_000,
  writable: true,
  commandTimeoutMs: 120_000
} as const;

/**
 * Loads `<dir>/.code-agent.json`. Returns null when the directory is not a
 * workspace; throws ConfigError when the marker exists but is unusable.
 */
export async function loadWorkspace(dir: string): Promise<WorkspaceConfig | null> {
  const file = path.join(dir, WORKSPACE_MARKER);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConfigError(`cannot read ${WORKSPACE_MARKER}: ${(err as Error).message}`, file);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigError(`invalid JSON: ${(err as Error).message}`, file);
  }

  const result = ConfigFileSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`invalid config: ${issues}`, file);
  }

  const cfg = result.data;
  // realpath so that every later sandbox check compares resolved paths only.
  const root = await realpath(dir);

  return {
    name: cfg.name ?? path.basename(root),
    root,
    allowedPaths: cfg.allowedPaths ?? [...DEFAULTS.allowedPaths],
    blockedPaths: [...HARD_BLOCKED_PATHS, ...(cfg.blockedPaths ?? [])],
    commands: cfg.commands ?? {},
    maxFileBytes: cfg.maxFileBytes ?? DEFAULTS.maxFileBytes,
    writable: cfg.writable ?? DEFAULTS.writable,
    commandTimeoutMs: cfg.commandTimeoutMs ?? DEFAULTS.commandTimeoutMs
  };
}

export interface DiscoveryProblem {
  dir: string;
  reason: string;
}

export interface DiscoveryResult {
  workspaces: WorkspaceConfig[];
  problems: DiscoveryProblem[];
}

/**
 * Scans each root for workspaces. A root may itself be a workspace, or a
 * directory whose immediate children are workspaces (the pairing layout the
 * README describes, `--workspace-root ~/projects`).
 */
export async function discoverWorkspaces(roots: string[]): Promise<DiscoveryResult> {
  const workspaces = new Map<string, WorkspaceConfig>();
  const problems: DiscoveryProblem[] = [];

  const consider = async (dir: string): Promise<boolean> => {
    try {
      const ws = await loadWorkspace(dir);
      if (!ws) return false;
      const existing = workspaces.get(ws.name);
      if (existing && existing.root !== ws.root) {
        problems.push({
          dir,
          reason: `duplicate workspace name "${ws.name}" (already mapped to ${existing.root})`
        });
        return true;
      }
      workspaces.set(ws.name, ws);
      return true;
    } catch (err) {
      problems.push({ dir, reason: (err as Error).message });
      return true;
    }
  };

  for (const rawRoot of roots) {
    let root: string;
    try {
      root = await realpath(path.resolve(rawRoot));
      if (!(await stat(root)).isDirectory()) {
        problems.push({ dir: rawRoot, reason: 'not a directory' });
        continue;
      }
    } catch (err) {
      problems.push({ dir: rawRoot, reason: (err as Error).message });
      continue;
    }

    const isWorkspace = await consider(root);
    if (isWorkspace) continue;

    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (err) {
      problems.push({ dir: root, reason: (err as Error).message });
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      await consider(path.join(root, entry.name));
    }
  }

  return {
    workspaces: [...workspaces.values()].sort((a, b) => a.name.localeCompare(b.name)),
    problems
  };
}
