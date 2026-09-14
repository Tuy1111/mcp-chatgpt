import { discoverWorkspaces, type DiscoveryProblem, type WorkspaceConfig } from './config.js';
import { SandboxError } from './sandbox.js';

/**
 * Holds the workspaces exposed over MCP. Configs are re-read on `refresh()` so
 * editing `.code-agent.json` does not require restarting the server.
 */
export class WorkspaceRegistry {
  private byName: Record<string, WorkspaceConfig> = {};
  private order: string[] = [];
  private problems: DiscoveryProblem[] = [];
  private lastScan = 0;

  constructor(readonly roots: string[]) {
    if (roots.length === 0) throw new Error('at least one workspace root is required');
  }

  async refresh(): Promise<void> {
    const { workspaces, problems } = await discoverWorkspaces(this.roots);
    const next: Record<string, WorkspaceConfig> = {};
    for (const ws of workspaces) next[ws.name] = ws;
    this.byName = next;
    this.order = workspaces.map((ws) => ws.name);
    this.problems = problems;
    this.lastScan = Date.now();
  }

  /** Refresh when the cached scan is older than `maxAgeMs`. */
  async ensureFresh(maxAgeMs = 5_000): Promise<void> {
    if (Date.now() - this.lastScan > maxAgeMs) await this.refresh();
  }

  list(): WorkspaceConfig[] {
    return this.order.map((name) => this.byName[name]!);
  }

  issues(): DiscoveryProblem[] {
    return this.problems;
  }

  /** Resolves a workspace by name, or the only workspace when name is omitted. */
  get(name?: string): WorkspaceConfig {
    if (name === undefined || name === '') {
      const all = this.list();
      if (all.length === 1) return all[0]!;
      throw new SandboxError(
        'INVALID',
        `workspace is required; available: ${this.order.join(', ') || '<none>'}`
      );
    }
    const ws = this.byName[name];
    if (!ws) {
      throw new SandboxError(
        'NOT_FOUND',
        `unknown workspace "${name}"; available: ${this.order.join(', ') || '<none>'}`
      );
    }
    return ws;
  }
}
