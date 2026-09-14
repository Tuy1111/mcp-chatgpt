#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer, resolveRoots } from '../server.js';

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'content-type, mcp-session-id, mcp-protocol-version, authorization',
  'access-control-expose-headers': 'mcp-session-id',
  'access-control-max-age': '86400'
};

function log(message: string): void {
  process.stderr.write(`[mcp-http] ${message}\n`);
}

interface Options {
  roots: string[];
  port: number;
  host: string;
}

function parseArgs(argv: string[]): Options {
  const roots: string[] = [];
  let port: string | undefined;
  let host: string | undefined;

  const take = (index: number, flag: string): string => {
    const value = argv[index];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    return value;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    // `npm run x -- --flag` needs the separator; pnpm 10 forwards it verbatim.
    if (arg === '--') continue;
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    switch (flag) {
      case '--workspace-root':
        roots.push(inline ?? take(++i, flag));
        break;
      case '--port':
        port = inline ?? take(++i, flag);
        break;
      case '--host':
        host = inline ?? take(++i, flag);
        break;
      default:
        throw new Error(`unknown argument "${arg}"`);
    }
  }

  const rawPort = port ?? process.env.PORT;
  const parsedPort = rawPort === undefined ? DEFAULT_PORT : Number(rawPort);
  if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
    throw new Error(`invalid port "${rawPort}"`);
  }

  return {
    roots: resolveRoots(roots),
    port: parsedPort,
    host: host ?? process.env.HOST ?? DEFAULT_HOST
  };
}

/** Hosts that never leave the machine; 127/8 as a whole is handled at the check. */
const LOOPBACK_HOSTS: Record<string, true> = {
  '127.0.0.1': true,
  localhost: true,
  '::1': true,
  '::ffff:127.0.0.1': true
};

function sendJson(res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS_HEADERS,
    ...extra,
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function rpcError(res: ServerResponse, status: number, code: number, message: string, extra?: Record<string, string>): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, extra);
}

/**
 * Reads the request body with a hard cap; returns null once 413 was sent.
 *
 * A declared oversize body is refused without reading a byte, and the socket is
 * torn down only after the response has flushed (an unread body would otherwise
 * desynchronise keep-alive framing). Undeclared bodies are drained but buffered
 * only up to the cap, so the response can be written without truncation.
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  const tooLarge = (): null => {
    res.on('finish', () => req.destroy());
    rpcError(res, 413, -32600, `Payload too large: limit is ${MAX_BODY_BYTES} bytes`);
    return null;
  };

  const declared = Number(req.headers['content-length'] ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return tooLarge();

  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  req.on('data', (chunk: Buffer) => {
    if (overflowed) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      overflowed = true;
      chunks.length = 0;
      return;
    }
    chunks.push(chunk);
  });
  await once(req, 'end');
  return overflowed ? tooLarge() : Buffer.concat(chunks);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer (.+)$/i.exec(header.trim());
  if (!match) return false;
  const presented = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  // timingSafeEqual throws on length mismatch, which itself leaks nothing new:
  // the length of the configured token is not secret, its bytes are.
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const token = process.env.MCP_AUTH_TOKEN ?? '';

  const loopback = LOOPBACK_HOSTS[opts.host] === true || opts.host.startsWith('127.');
  if (token === '' && !loopback) {
    process.stderr.write(
      `\u001b[31m[mcp-http] refusing to bind ${opts.host} without MCP_AUTH_TOKEN: ` +
        `an unauthenticated MCP server grants anyone on the network read/write access to your workspaces.\u001b[0m\n`
    );
    process.exit(1);
  }

  // Bootstrap bundle: never connected to a transport. It validates the roots at
  // startup and backs /healthz; each session gets its own server instance
  // because an McpServer owns exactly one transport.
  const bootstrap = await createMcpServer({ roots: opts.roots });
  log(`roots: ${opts.roots.map((root) => path.resolve(root)).join(', ')}`);
  const names = bootstrap.registry.list().map((ws) => ws.name);
  log(names.length > 0 ? `workspaces: ${names.join(', ')}` : 'workspaces: <none found>');
  for (const issue of bootstrap.registry.issues()) log(`issue: ${issue.dir}: ${issue.reason}`);
  if (token === '') log('auth: disabled (loopback bind); set MCP_AUTH_TOKEN to require a bearer token');

  const sessions = new Map<string, Session>();
  const startedAt = Date.now();

  const createSession = async (): Promise<StreamableHTTPServerTransport> => {
    const { server } = await createMcpServer({ roots: opts.roots });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { server, transport });
        log(`session opened ${sessionId.slice(0, 8)} (${sessions.size} open)`);
      },
      onsessionclosed: (sessionId) => {
        sessions.delete(sessionId);
        log(`session closed ${sessionId.slice(0, 8)} (${sessions.size} open)`);
      }
    });
    // Protocol.connect() takes over transport.onclose, so hook the server side.
    server.server.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId !== undefined) sessions.delete(sessionId);
    };
    await server.connect(transport);
    return transport;
  };

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (token !== '' && !authorized(req, token)) {
      rpcError(res, 401, -32001, 'Unauthorized: expected Authorization: Bearer <MCP_AUTH_TOKEN>', {
        'www-authenticate': 'Bearer realm="mcp"'
      });
      return;
    }

    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const existing = sessionId === undefined ? undefined : sessions.get(sessionId);

    if (req.method !== 'POST') {
      if (sessionId === undefined) {
        rpcError(res, 400, -32000, 'Bad Request: no valid session ID');
        return;
      }
      if (!existing) {
        rpcError(res, 404, -32001, 'Session not found');
        return;
      }
      await existing.transport.handleRequest(req, res);
      return;
    }

    // The body must be parsed here to route by session, so it is handed to the
    // transport pre-parsed: the underlying stream is already drained.
    const raw = await readBody(req, res);
    if (raw === null) return;
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      rpcError(res, 400, -32700, 'Parse error: body is not valid JSON');
      return;
    }

    if (existing) {
      await existing.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId !== undefined) {
      rpcError(res, 404, -32001, 'Session not found');
      return;
    }
    const isInit = Array.isArray(body) ? body.some(isInitializeRequest) : isInitializeRequest(body);
    if (!isInit) {
      rpcError(res, 400, -32000, 'Bad Request: no valid session ID');
      return;
    }
    const transport = await createSession();
    await transport.handleRequest(req, res, body);
  };

  const httpServer = createServer((req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? opts.host}`);
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    res.on('finish', () => {
      const tag = sessionId === undefined ? '-' : sessionId.slice(0, 8);
      log(`${req.method} ${url.pathname} ${res.statusCode} ${tag} ${Date.now() - started}ms`);
    });

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, {
        status: 'ok',
        workspaces: bootstrap.registry.list().map((ws) => ws.name),
        sessions: sessions.size,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000)
      });
      return;
    }

    if (url.pathname === '/mcp') {
      const method = req.method ?? '';
      if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
        rpcError(res, 405, -32000, `Method not allowed: ${method}`, { allow: 'GET, POST, DELETE, OPTIONS' });
        return;
      }
      handleMcp(req, res).catch((err: unknown) => {
        log(`handler failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        if (!res.headersSent) rpcError(res, 500, -32603, 'Internal server error');
        else res.end();
      });
      return;
    }

    sendJson(res, 404, { error: 'not found', endpoints: ['/mcp', '/healthz'] });
  });

  httpServer.listen(opts.port, opts.host, () => {
    log(`listening on http://${opts.host}:${opts.port}/mcp (health: /healthz)`);
  });

  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      log(`${signal} received, shutting down (${sessions.size} session(s))`);
      const open = [...sessions.values()];
      sessions.clear();
      httpServer.close();
      void Promise.allSettled([
        ...open.flatMap((session) => [session.transport.close(), session.server.close()]),
        bootstrap.server.close()
      ]).then(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});
