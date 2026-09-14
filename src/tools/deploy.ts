import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatDeployResult, loadDeployConfig, runDeploy, type DeployConfig } from '../deploy.js';
import { fail, guard, ok } from '../result.js';

/**
 * Exposes the redeploy pipeline as a tool so any MCP client — Hermes on
 * Telegram, ChatGPT, a CLI — can ship the VPS by asking for it.
 *
 * This is the only tool that escapes the path sandbox: it runs `git` and
 * `docker compose` on the host. It is therefore off unless `DEPLOY_ENABLED` is
 * exactly `true`, and it is registered as destructive so clients that gate
 * write actions (ChatGPT and Hermes both do) prompt before running it.
 */
export function registerDeployTools(server: McpServer): void {
  let config: DeployConfig | null = null;
  let configError: string | null = null;
  try {
    config = loadDeployConfig(process.env);
  } catch (err) {
    // A malformed DEPLOY_* value must not stop the whole server from starting:
    // every other tool is still useful. Report it when `deploy` is called.
    configError = err instanceof Error ? err.message : String(err);
  }

  server.registerTool(
    'deploy',
    {
      title: 'Deploy the server',
      description:
        'Pulls the latest commit in the deploy checkout, rebuilds the configured docker compose services and restarts them. Use only when the user asks to deploy or ship. Returns the per-step log; a non-zero step means the deploy failed and nothing was restarted after it.',
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
    },
    guard(async () => {
      if (configError !== null) return fail(`CONFIG: ${configError}`);
      if (config === null) return fail('CONFIG: deploy configuration was not loaded');
      if (!config.enabled) {
        return fail(
          'DISABLED: deploy is off. Set DEPLOY_ENABLED=true and DEPLOY_REPO_DIR on the server, then restart it.'
        );
      }
      // Progress notes are dropped: MCP has no mid-call channel back to a
      // chat, and the per-step log in the result carries the same detail.
      const result = await runDeploy(config, () => {});
      return ok(formatDeployResult(result));
    })
  );
}
