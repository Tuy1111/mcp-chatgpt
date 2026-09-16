#!/usr/bin/env node
// Windows code agent for chatgpt-code-mcp gateway.
//
// Flow: ChatGPT -> gateway (mcp.tuyng.online, OAuth) -> THIS agent (WebSocket)
// -> your local code folders. The gateway forwards every tool call here; the
// files never leave your machine except as the specific reads/edits ChatGPT asks for.
//
// First run pairs with the gateway (you approve once with the Owner password),
// then it stays connected and reconnects automatically.
//
// Requires: `ws` package (npm install ws). Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { Registry, makeTools } from './tools.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- config ---------------------------------------------------------------
function parseArgs(argv) {
  const roots = [];
  let gateway, machineId;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const val = () => inline ?? argv[++i];
    if (flag === '--workspace-root') roots.push(val());
    else if (flag === '--gateway') gateway = val();
    else if (flag === '--machine-id') machineId = val();
    else throw new Error(`unknown argument "${arg}"`);
  }
  return { roots, gateway, machineId };
}

const args = parseArgs(process.argv.slice(2));
const GATEWAY = (args.gateway ?? process.env.GATEWAY ?? 'https://mcp.tuyng.online').replace(/\/$/, '');
const ROOTS = args.roots.length > 0 ? args.roots
  : (process.env.WORKSPACE_ROOTS ? process.env.WORKSPACE_ROOTS.split(path.delimiter) : []);
const MACHINE_ID = args.machineId ?? process.env.MACHINE_ID ?? `win-${os.hostname()}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 63);
const STATE_FILE = process.env.AGENT_STATE ?? path.join(HERE, '.agent-state.json');

if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(MACHINE_ID)) {
  console.error(`Invalid machine id "${MACHINE_ID}" — use letters, digits, _ and - (2-64 chars).`);
  process.exit(1);
}
if (ROOTS.length === 0) {
  console.error('No workspace roots. Pass --workspace-root "C:\\path\\to\\project" (must contain .code-agent.json), or set WORKSPACE_ROOTS.');
  process.exit(1);
}

const registry = new Registry(ROOTS);
const tools = makeTools(registry);

function log(msg) { process.stdout.write(`[agent] ${new Date().toISOString()} ${msg}\n`); }

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
  try { fs.chmodSync(STATE_FILE, 0o600); } catch { /* windows */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- pairing --------------------------------------------------------------
async function pair() {
  log(`Pairing machine "${MACHINE_ID}" with ${GATEWAY} ...`);
  const reqRes = await fetch(`${GATEWAY}/api/pair/request`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ machineId: MACHINE_ID })
  });
  if (!reqRes.ok) throw new Error(`pair/request failed: HTTP ${reqRes.status} ${await reqRes.text()}`);
  const { requestId, pollSecret, code, approvalUrl } = await reqRes.json();

  console.log('\n============================================================');
  console.log('  APPROVE THIS MACHINE');
  console.log('  1. Open this URL in a browser:');
  console.log(`       ${approvalUrl ?? `${GATEWAY}/pair/${code}`}`);
  console.log(`  2. Enter the Owner password and click Approve.`);
  console.log(`  (pairing code: ${code} — expires in 10 minutes)`);
  console.log('============================================================\n');

  for (;;) {
    await sleep(3000);
    const pollRes = await fetch(`${GATEWAY}/api/pair/poll`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId, pollSecret })
    });
    if (!pollRes.ok) { log(`poll HTTP ${pollRes.status}, retrying...`); continue; }
    const data = await pollRes.json();
    if (data.status === 'pending') { process.stdout.write('.'); continue; }
    if (data.status === 'expired') throw new Error('pairing code expired; run the agent again to get a new one');
    if (data.status === 'approved' && data.agentToken) {
      const state = loadState();
      state[MACHINE_ID] = { agentToken: data.agentToken, gateway: GATEWAY };
      saveState(state);
      log('Approved. Token saved.');
      return data.agentToken;
    }
    if (data.status === 'consumed') throw new Error('pairing already consumed; delete .agent-state.json and re-run');
  }
}

async function getToken() {
  const state = loadState();
  const entry = state[MACHINE_ID];
  if (entry && entry.gateway === GATEWAY && entry.agentToken) return entry.agentToken;
  return pair();
}

// ---- websocket + rpc ------------------------------------------------------
async function dispatch(tool, rawArgs) {
  const fn = tools[tool];
  if (!fn) throw new Error(`unknown tool "${tool}"`);
  return fn(rawArgs ?? {});
}

function connect(token) {
  const wsUrl = GATEWAY.replace(/^http/, 'ws') + `/agent/ws?machine_id=${encodeURIComponent(MACHINE_ID)}`;
  const ws = new WebSocket(wsUrl, { headers: { authorization: `Bearer ${token}` } });
  let alive = true;

  ws.on('open', () => log(`Connected to gateway as "${MACHINE_ID}". Waiting for ChatGPT requests.`));

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    if (msg.type === 'welcome') { log(`Gateway welcome (machine ${msg.machineId}).`); return; }
    if (msg.type !== 'rpc_request' || typeof msg.id !== 'string') return;
    const started = Date.now();
    try {
      const result = await dispatch(msg.tool, msg.args);
      ws.send(JSON.stringify({ type: 'rpc_response', id: msg.id, result }));
      log(`${msg.tool} ok (${Date.now() - started}ms)`);
    } catch (err) {
      const message = err && err.code ? `${err.code}: ${err.message}` : String(err && err.message ? err.message : err);
      ws.send(JSON.stringify({ type: 'rpc_response', id: msg.id, error: message }));
      log(`${msg.tool} error: ${message}`);
    }
  });

  ws.on('close', (codeNum) => { alive = false; log(`Disconnected (code ${codeNum}).`); });
  ws.on('error', (err) => { log(`Socket error: ${err.message}`); });

  return { ws, isAlive: () => alive };
}

// ---- main loop with auto-reconnect ----------------------------------------
async function main() {
  const workspaces = await registry.list();
  log(`Workspaces found: ${workspaces.map((w) => w.name).join(', ') || '(none — check .code-agent.json in your roots)'}`);
  for (const p of registry.problems ?? []) log(`workspace issue: ${p.dir}: ${p.reason}`);

  let backoff = 2000;
  for (;;) {
    let token;
    try { token = await getToken(); }
    catch (err) { log(`Pairing failed: ${err.message}`); await sleep(5000); continue; }

    // 401 on connect => token no longer valid; drop it and re-pair.
    const conn = connect(token);
    let unauthorized = false;
    conn.ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401) {
        unauthorized = true;
        const state = loadState(); delete state[MACHINE_ID]; saveState(state);
        log('Token rejected (401). Will re-pair.');
      }
    });

    await new Promise((resolve) => { conn.ws.on('close', resolve); conn.ws.on('error', () => {}); });
    if (unauthorized) { backoff = 2000; continue; }
    log(`Reconnecting in ${Math.round(backoff / 1000)}s...`);
    await sleep(backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }
}

main().catch((err) => { log(`fatal: ${err.stack || err.message}`); process.exit(1); });
