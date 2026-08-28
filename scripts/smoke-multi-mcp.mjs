#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { DEFAULT_RESTART_QUIESCENCE_WINDOW_MS } from '../src/server/services/mcpTransportMonitor.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const CLIENT_COUNT = 5;
const LOCAL_ROUNDS = 3;
const MCP_TIMEOUT_MS = 15_000;
const HTTP_TIMEOUT_MS = 10_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const LOCAL_SESSION_IDLE_TTL_MS = 8_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function percentile(values, percentileValue) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return Math.round(sorted[index] * 100) / 100;
}

function parseMode() {
  const modeIndex = process.argv.indexOf('--mode');
  const mode = modeIndex >= 0 ? String(process.argv[modeIndex + 1] || '') : 'all';
  if (mode === 'public') {
    throw new Error('Public URL smoke mode was retired with OpenAI Tunnel. Use npm run tunnel:status plus a real ChatGPT MCP call for tunnel-path verification.');
  }
  if (!['all', 'local'].includes(mode)) {
    throw new Error(`Unsupported --mode '${mode}'. Expected all or local.`);
  }
  return mode;
}

async function fetchJson(baseUrl, route, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await fetch(new URL(route, `${baseUrl.replace(/\/$/, '')}/`), {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let body;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    if (!response.ok || !body) {
      throw new Error(`HTTP ${response.status} from ${route}; expected JSON.`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttp(baseUrl, route = '/api/capabilities', timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await fetchJson(baseUrl, route);
    } catch (error) {
      lastError = error;
      await sleep(150);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${route}.`);
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to allocate a local smoke-test port.');
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function boundedLogCollector(child) {
  let stdout = '';
  let stderr = '';
  const append = (current, chunk) => `${current}${String(chunk)}`.slice(-12_000);
  child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
  child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
  return {
    dump() {
      return [stdout.trim(), stderr.trim()].filter(Boolean).join('\n').slice(-4_000);
    },
  };
}

function waitForExit(child, timeoutMs = 15_000) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for child server exit.')), timeoutMs);
    timer.unref?.();
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function connectClient(baseUrl, label) {
  const client = new Client({ name: `devflow-multi-mcp-${label}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', `${baseUrl.replace(/\/$/, '')}/`));
  await client.connect(transport);
  return { client, transport };
}

function textPayload(result) {
  const text = result?.content?.find?.((entry) => entry?.type === 'text')?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return { text }; }
}

async function callTool(client, name, args = {}) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: MCP_TIMEOUT_MS });
    return { result, payload: textPayload(result), thrown: null };
  } catch (error) {
    return { result: null, payload: null, thrown: error };
  }
}

function errorCodeFromCall(call) {
  const payload = call.payload || {};
  const candidates = [payload?.error?.code, payload?.code, payload?.details?.code, call.thrown?.code, call.thrown?.message];
  const rendered = candidates.filter(Boolean).map(String).join(' ');
  const match = rendered.match(/\b(RESTART_BUSY|RESTART_UNSUPPORTED|[A-Z][A-Z0-9_]{3,})\b/);
  return match?.[1] || null;
}

async function runFiveClientProfile(baseUrl, rounds, label, onRound) {
  const connectedAt = Date.now();
  const clients = await Promise.all(Array.from({ length: CLIENT_COUNT }, (_, index) => connectClient(baseUrl, `${label}-${index + 1}`)));
  const initialSessionIds = clients.map(({ transport }) => String(transport.sessionId || ''));
  initialSessionIds.forEach((sessionId, index) => assert.match(sessionId, /^[0-9a-f-]{20,}$/i, `${label} client ${index + 1} did not receive a reusable MCP session id.`));
  assert.equal(new Set(initialSessionIds).size, CLIENT_COUNT, `${label} clients must hold isolated MCP sessions.`);
  const roundDurations = [];
  let listCalls = 0;
  let toolCalls = 0;
  try {
    for (let round = 0; round < rounds; round += 1) {
      const startedAt = Date.now();
      await Promise.all(clients.map(async ({ client }, index) => {
        const listed = await client.listTools(undefined, { timeout: MCP_TIMEOUT_MS });
        assert.ok(listed.tools?.length, `${label} client ${index + 1} received no MCP tools in round ${round + 1}.`);
        listCalls += 1;
        const called = await callTool(client, 'devflow_health_check', { responseMode: 'compact' });
        if (called.thrown) throw called.thrown;
        assert.notEqual(called.result?.isError, true, `${label} client ${index + 1} devflow_health_check failed: ${JSON.stringify(called.payload)}`);
        assert.ok(called.result?.content?.length, `${label} client ${index + 1} devflow_health_check returned no content.`);
        toolCalls += 1;
      }));
      roundDurations.push(Date.now() - startedAt);
      await onRound?.(round + 1);
    }
    const finalSessionIds = clients.map(({ transport }) => String(transport.sessionId || ''));
    assert.deepEqual(finalSessionIds, initialSessionIds, `${label} clients changed MCP session ids across repeated calls.`);
    return {
      clients,
      sessionIds: initialSessionIds,
      metrics: {
        clientCount: CLIENT_COUNT,
        rounds,
        initializeCalls: CLIENT_COUNT,
        listCalls,
        toolCalls,
        boundedMcpOperations: CLIENT_COUNT + listCalls + toolCalls,
        elapsedMs: Date.now() - connectedAt,
        roundP50Ms: percentile(roundDurations, 50),
        roundP95Ms: percentile(roundDurations, 95),
      },
    };
  } catch (error) {
    await Promise.all(clients.map(({ client }) => client.close().catch(() => {})));
    throw error;
  }
}

async function closeProfile(profile) {
  await Promise.all(profile.clients.map(({ client }) => client.close().catch(() => {})));
}

function rawMcpHeaders(sessionId, accept = 'application/json, text/event-stream') {
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    'mcp-protocol-version': MCP_PROTOCOL_VERSION,
    ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
  };
}

async function rawMcpPost(baseUrl, body, sessionId) {
  return fetch(new URL('/mcp', `${baseUrl.replace(/\/$/, '')}/`), {
    method: 'POST',
    headers: rawMcpHeaders(sessionId),
    body: JSON.stringify(body),
  });
}

async function exerciseInterruptedRawSession(baseUrl, profile) {
  const initialized = await rawMcpPost(baseUrl, {
    jsonrpc: '2.0',
    id: 'raw-retention-init',
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'devflow-raw-retention-smoke', version: '1.0.0' },
    },
  });
  assert.equal(initialized.status, 200, `Raw MCP initialize failed with HTTP ${initialized.status}.`);
  const sessionId = initialized.headers.get('mcp-session-id') || '';
  assert.match(sessionId, /^[0-9a-f-]{20,}$/i, 'Raw MCP initialize did not return a session id.');
  await initialized.body?.cancel();

  const abortController = new AbortController();
  const interruptedStream = await fetch(new URL('/mcp', `${baseUrl.replace(/\/$/, '')}/`), {
    method: 'GET',
    headers: rawMcpHeaders(sessionId, 'text/event-stream'),
    signal: abortController.signal,
  });
  assert.equal(interruptedStream.status, 200, `Raw MCP GET stream failed with HTTP ${interruptedStream.status}.`);
  abortController.abort();
  await interruptedStream.body?.cancel().catch(() => {});
  await sleep(100);

  const reusedBeforeExpiry = await rawMcpPost(baseUrl, {
    jsonrpc: '2.0', id: 'raw-retention-before-expiry', method: 'tools/list', params: {},
  }, sessionId);
  assert.equal(reusedBeforeExpiry.status, 200, `Interrupted raw session was not reusable before expiry: HTTP ${reusedBeforeExpiry.status}.`);
  await reusedBeforeExpiry.body?.cancel();

  await Promise.all(profile.clients.map(({ client }, index) => client.listTools(undefined, { timeout: MCP_TIMEOUT_MS })
    .then((listed) => assert.ok(listed.tools?.length, `Official client ${index + 1} failed after raw GET interruption.`))));

  await sleep(Math.floor(LOCAL_SESSION_IDLE_TTL_MS / 2));
  await Promise.all(profile.clients.map(({ client }) => client.listTools(undefined, { timeout: MCP_TIMEOUT_MS })));
  await sleep(Math.ceil(LOCAL_SESSION_IDLE_TTL_MS / 2) + 300);

  const staleAfterExpiry = await rawMcpPost(baseUrl, {
    jsonrpc: '2.0', id: 'raw-retention-after-expiry', method: 'tools/list', params: {},
  }, sessionId);
  assert.equal(staleAfterExpiry.status, 404, `Raw session should become stale only after configured expiry; got HTTP ${staleAfterExpiry.status}.`);
  await staleAfterExpiry.body?.cancel();

  await Promise.all(profile.clients.map(({ client }, index) => client.listTools(undefined, { timeout: MCP_TIMEOUT_MS })
    .then((listed) => assert.ok(listed.tools?.length, `Official client ${index + 1} did not survive the compressed retention boundary.`))));
  const finalOfficialSessionIds = profile.clients.map(({ transport }) => String(transport.sessionId || ''));
  assert.deepEqual(finalOfficialSessionIds, profile.sessionIds, 'Official MCP sessions changed during raw interruption/retention smoke.');

  return {
    configuredIdleTtlMs: LOCAL_SESSION_IDLE_TTL_MS,
    rawSessionObserved: true,
    getStreamInterrupted: true,
    reusableBeforeExpiry: true,
    staleStatusAfterExpiry: staleAfterExpiry.status,
    officialClientSessionsStable: true,
  };
}

function gitRevision() {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true }).trim();
}

async function runLocalMode() {
  const port = await getFreePort();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-multi-mcp-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', path.join(REPO_ROOT, 'server.ts')], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DEVFLOW_PORT: String(port),
      PORT: String(port),
      DEVFLOW_APP_ROOT: REPO_ROOT,
      DEVFLOW_DB_PATH: path.join(tempRoot, 'devflow.db'),
      DEVFLOW_RUNTIME_DIR: path.join(tempRoot, '.runtime'),
      DEVFLOW_RESTART_SUPERVISOR: 'start-all',
      DEVFLOW_RESTART_SUPERVISOR_TOKEN: 'multi-mcp-local-smoke-token',
      DEVFLOW_OPEN_BROWSER: 'false',
      DEVFLOW_MCP_SESSION_IDLE_TTL_MS: String(LOCAL_SESSION_IDLE_TTL_MS),
      DISABLE_HMR: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const logs = boundedLogCollector(child);
  let profile;
  try {
    const capabilityBefore = await waitForHttp(baseUrl);
    const revisionBefore = gitRevision();
    const childPid = child.pid;
    assert.ok(childPid, 'Local DevFlow child did not expose a PID.');

    profile = await runFiveClientProfile(baseUrl, LOCAL_ROUNDS, 'local');
    const sessionRetention = await exerciseInterruptedRawSession(baseUrl, profile);
    const busyRestart = await callTool(profile.clients[0].client, 'restart_devflow', { reason: 'multi-mcp local busy-gate smoke' });
    assert.equal(errorCodeFromCall(busyRestart), 'RESTART_BUSY', 'restart_devflow must be rejected while recent meaningful MCP work is hot.');
    assert.equal(child.exitCode, null, 'Blocked restart must not exit the local API process.');

    const capabilityAfterProfile = await fetchJson(baseUrl, '/api/capabilities');
    assert.equal(capabilityAfterProfile.runtimeInstanceId, capabilityBefore.runtimeInstanceId, 'Local API runtime identity changed during the bounded MCP profile.');
    assert.equal(capabilityAfterProfile.contractVersion, capabilityBefore.contractVersion, 'Local API contract revision changed during the bounded MCP profile.');
    assert.equal(gitRevision(), revisionBefore, 'Repository revision changed during the local smoke run.');

    await sleep(DEFAULT_RESTART_QUIESCENCE_WINDOW_MS + 350);
    const acceptedRestart = await callTool(profile.clients[0].client, 'restart_devflow', { reason: 'multi-mcp local quiescent restart smoke' });
    if (acceptedRestart.thrown) throw acceptedRestart.thrown;
    assert.notEqual(acceptedRestart.result?.isError, true, `restart_devflow should be accepted after quiescence: ${JSON.stringify(acceptedRestart.payload)}`);
    assert.equal(acceptedRestart.payload?.accepted, true, `Expected accepted restart after quiescence, got ${JSON.stringify(acceptedRestart.payload)}`);
    const exit = await waitForExit(child);
    assert.equal(exit.code, 75, `Expected explicit quiescent restart to exit child with code 75, got ${exit.code ?? exit.signal}.`);

    return {
      mode: 'local',
      ...profile.metrics,
      apiPid: childPid,
      apiPidStableUntilExplicitRestart: true,
      runtimeInstanceIdStableDuringProfile: true,
      contractVersion: capabilityBefore.contractVersion,
      repoRevision: revisionBefore,
      sessionRetention,
      restartGuard: {
        busyResult: 'RESTART_BUSY',
        idleClientsStayedConnectedDuringQuiescence: true,
        quiescenceWindowMs: DEFAULT_RESTART_QUIESCENCE_WINDOW_MS,
        acceptedAfterQuiescence: true,
        explicitRestartExitCode: exit.code,
      },
    };
  } catch (error) {
    const detail = logs.dump();
    if (detail) console.error(`[local-child-log]\n${detail}`);
    throw error;
  } finally {
    if (profile) await closeProfile(profile).catch(() => {});
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        child.kill();
      }
      await waitForExit(child, 5_000).catch(() => {});
    }
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (cleanupError) {
      console.error(`[smoke-multi-mcp] cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`);
    }
  }
}

async function main() {
  parseMode();
  const result = {
    schemaVersion: 1,
    clientCount: CLIENT_COUNT,
    boundedProfile: true,
    local: await runLocalMode(),
    tunnelPathVerification: 'Use npm run tunnel:status plus a real ChatGPT MCP call; OpenAI Tunnel does not expose a provider public URL for this local smoke.',
  };
  console.log('[smoke-multi-mcp] PASS');
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error('[smoke-multi-mcp] FAIL:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
