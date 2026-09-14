#!/usr/bin/env node
import path from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, resolveRoots } from '../server.js';

/**
 * stdout is the JSON-RPC channel on this transport, so diagnostics go to stderr
 * only. A stray console.log corrupts the framing and the client drops us.
 */
function log(message: string): void {
  process.stderr.write(`[mcp-stdio] ${message}\n`);
}

function parseArgs(argv: string[]): string[] {
  const roots: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `npm run x -- --flag` needs the separator; pnpm 10 forwards it verbatim.
    if (arg === '--') continue;
    if (arg === '--workspace-root') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--workspace-root requires a path');
      roots.push(value);
      i += 1;
    } else if (arg.startsWith('--workspace-root=')) {
      roots.push(arg.slice('--workspace-root='.length));
    } else {
      throw new Error(`unknown argument "${arg}"`);
    }
  }
  return resolveRoots(roots);
}

async function main(): Promise<void> {
  const roots = parseArgs(process.argv.slice(2));
  const { server, registry } = await createMcpServer({ roots });

  const names = registry.list().map((ws) => ws.name);
  log(`roots: ${roots.map((root) => path.resolve(root)).join(', ')}`);
  log(names.length > 0 ? `workspaces: ${names.join(', ')}` : 'workspaces: <none found>');
  for (const issue of registry.issues()) log(`issue: ${issue.dir}: ${issue.reason}`);

  await server.connect(new StdioServerTransport());
  log('connected on stdio');

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      log(`${signal} received, closing`);
      server
        .close()
        .catch((err: unknown) => log(`close failed: ${String(err)}`))
        .finally(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
