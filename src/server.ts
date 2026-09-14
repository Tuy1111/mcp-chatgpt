import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WorkspaceRegistry } from './registry.js';
import { okJson } from './result.js';
import { registerFsTools } from './tools/fs.js';
import { registerSearchTools } from './tools/search.js';
import { registerGitTools } from './tools/git.js';
import { registerExecTools } from './tools/exec.js';
import { registerDeployTools } from './tools/deploy.js';

export const DEFAULT_SERVER_NAME = 'chatgpt-code-mcp';
/**
 * Single source of truth: reported to clients on `initialize`, so a manifest
 * bump cannot silently leave the advertised version behind.
 */
export const DEFAULT_SERVER_VERSION: string = (() => {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  if (parsed !== null && typeof parsed === 'object' && 'version' in parsed) {
    const { version } = parsed;
    if (typeof version === 'string') return version;
  }
  return '0.0.0';
})();

/**
 * Handed to the model on connect. It encodes the three rules that clients get
 * wrong most often: workspaces must be discovered (names are not guessable),
 * paths are workspace-relative, and patches are optimistically locked by the
 * sha256 that `file_read` returns.
 */
const INSTRUCTIONS = `Sandboxed access to local code workspaces.

1. Call workspaces_list first. Workspace names come from that call; never guess one.
   Pass the name as the "workspace" argument on every other tool (it may be omitted
   only when exactly one workspace exists).
2. Every "path" argument is relative to the workspace root and uses forward slashes.
   Absolute paths, drive letters and "..": rejected by the sandbox.
3. Before file_apply_patch, call file_read on the target and pass back the sha256 it
   returned. A stale hash aborts the patch instead of clobbering newer content.
4. Prefer code_search / file_list to locate code before reading whole files; output is
   capped, so narrow requests with path and line arguments.`;

export interface ServerOptions {
  roots: string[];
  name?: string;
  version?: string;
}

export interface ServerBundle {
  server: McpServer;
  registry: WorkspaceRegistry;
}

/**
 * Fallback chain for workspace roots, shared by both entrypoints:
 * explicit `--workspace-root` flags, then `MCP_WORKSPACE_ROOTS`, then cwd.
 */
export function resolveRoots(explicit: string[]): string[] {
  if (explicit.length > 0) return explicit;
  const fromEnv = (process.env.MCP_WORKSPACE_ROOTS ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return fromEnv.length > 0 ? fromEnv : [process.cwd()];
}

export async function createMcpServer(opts: ServerOptions): Promise<ServerBundle> {
  const server = new McpServer(
    { name: opts.name ?? DEFAULT_SERVER_NAME, version: opts.version ?? DEFAULT_SERVER_VERSION },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, resources: {} } }
  );

  const registry = new WorkspaceRegistry(opts.roots);
  await registry.refresh();

  server.registerTool(
    'workspaces_list',
    {
      title: 'List workspaces',
      description:
        'Lists the workspaces this server exposes, with their roots, allow/block globs, whitelisted command names and limits. Call this before any other tool.',
      inputSchema: {},
      annotations: { readOnlyHint: true }
    },
    async () => {
      // Re-scan so a workspace added after startup shows up without a restart.
      await registry.refresh();
      return okJson({
        workspaces: registry.list().map((ws) => ({
          name: ws.name,
          root: ws.root,
          allowedPaths: ws.allowedPaths,
          blockedPaths: ws.blockedPaths,
          commands: Object.keys(ws.commands),
          writable: ws.writable,
          maxFileBytes: ws.maxFileBytes
        })),
        issues: registry.issues()
      });
    }
  );

  registerFsTools(server, registry);
  registerSearchTools(server, registry);
  registerGitTools(server, registry);
  registerExecTools(server, registry);
  registerDeployTools(server);

  server.registerResource(
    'workspace-config',
    new ResourceTemplate('workspace://{name}/config', {
      list: async () => ({
        resources: registry.list().map((ws) => ({
          uri: `workspace://${ws.name}/config`,
          name: `${ws.name} config`,
          mimeType: 'application/json'
        }))
      })
    }),
    {
      title: 'Workspace configuration',
      description: 'Effective sandbox configuration of one workspace, as JSON.',
      mimeType: 'application/json'
    },
    async (uri, variables) => {
      const raw = variables.name;
      const name = Array.isArray(raw) ? raw[0] : raw;
      await registry.ensureFresh();
      const ws = registry.get(name);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(ws, null, 2)
          }
        ]
      };
    }
  );

  return { server, registry };
}
