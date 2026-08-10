import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-identity-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { DEVFLOW_CONTRACT_VERSION } = await import('../../src/server/contracts/devflowContract.js');
const { getDevFlowDiagnostics } = await import('../../src/server/services/mcpToolMonitor.js');
const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerDevFlowRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
    restartProcess: () => {},
  } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind runtime diagnostics test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('runtime identity is stable for one process and exposed in compact diagnostics', () => {
  const first = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const second = getDevFlowDiagnostics({ supervisorState: null } as any) as any;

  assert.match(first.runtime.runtimeInstanceId, /^[0-9a-f-]{20,}$/i);
  assert.equal(first.runtime.runtimeInstanceId, second.runtime.runtimeInstanceId);
  assert.equal(first.runtime.runtimeStartedAt, second.runtime.runtimeStartedAt);
  assert.equal(first.runtime.contractVersion, DEVFLOW_CONTRACT_VERSION);
  assert.ok(Array.isArray(first.runtime.transport));
  assert.deepEqual(first.runtime.transport, ['streamable-http', 'legacy-sse']);
});

test('runtime transport metadata reports both migration transports after the /mcp cutover', () => {
  const diagnostics = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  assert.deepEqual(diagnostics.runtime.transport, ['streamable-http', 'legacy-sse']);
});

test('runtime diagnostics expose tool-surface identity and distinguish schema drift from a pure restart', () => {
  const current = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  assert.equal(typeof current.runtime.toolSurfaceIdentity, 'string');
  assert.match(current.runtime.toolSurfaceIdentity, /^[0-9a-f]{64}$/);

  const restarted = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: 'previous-runtime',
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(restarted.runtimeDiagnosis.code, 'runtime-restarted');

  const schemaChanged = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: 'previous-runtime',
      toolSurfaceIdentity: '0'.repeat(64),
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(schemaChanged.runtimeDiagnosis.code, 'tool-surface-changed');
  assert.match(schemaChanged.runtimeDiagnosis.nextAction, /refresh|reconnect|registry/i);
});

test('a fresh process receives a different runtime instance id', () => {
  const parent = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-identity-child-'));
  const code = [
    `process.env.DEVFLOW_APP_ROOT=${JSON.stringify(childRoot)};`,
    `process.env.DEVFLOW_DB_PATH=${JSON.stringify(path.join(childRoot, 'devflow.db'))};`,
    `process.env.DEVFLOW_JOBS_DIR=${JSON.stringify(path.join(childRoot, 'jobs'))};`,
    `const migrations=await import('./src/db/migrations/index.js');`,
    `migrations.executeAllMigrations();`,
    `const monitor=await import('./src/server/services/mcpToolMonitor.js');`,
    `console.log(monitor.getDevFlowDiagnostics({supervisorState:null}).runtime.runtimeInstanceId);`,
  ].join('');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const childId = child.stdout.trim().split(/\r?\n/).at(-1) || '';
  assert.match(childId, /^[0-9a-f-]{20,}$/i);
  assert.notEqual(childId, parent.runtime.runtimeInstanceId);
});

test('runtime diagnostics classify restart, deployment change, and likely client registry desync', () => {
  const current = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const common = { supervisorState: null };

  const restarted = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: DEVFLOW_CONTRACT_VERSION,
      runtimeInstanceId: 'previous-runtime',
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(restarted.runtimeDiagnosis.code, 'runtime-restarted');
  assert.match(restarted.runtimeDiagnosis.nextAction, /reconnect/i);

  const deployed = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: 'older-contract',
      runtimeInstanceId: 'previous-runtime',
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(deployed.runtimeDiagnosis.code, 'deployment-changed');
  assert.match(deployed.runtimeDiagnosis.nextAction, /refresh|reconnect/i);

  const desynced = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolsVisible: false,
    },
  } as any) as any;
  assert.equal(desynced.runtimeDiagnosis.code, 'client-registry-desync');
  assert.equal(desynced.runtimeDiagnosis.recoverySurface, 'get_recovery_handoff');
  assert.match(desynced.runtimeDiagnosis.nextAction, /fresh chat|refresh|reconnect/i);
  assert.match(desynced.runtimeDiagnosis.detail, /cannot repair/i);
});

test('capabilities and diagnostics routes expose runtime identity and accept client observation hints', async () => {
  await withServer(async (baseUrl) => {
    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
    const capabilities = await capabilitiesResponse.json() as any;
    assert.equal(capabilitiesResponse.status, 200);
    assert.equal(capabilities.contractVersion, DEVFLOW_CONTRACT_VERSION);
    assert.match(capabilities.toolSurfaceIdentity, /^[0-9a-f]{64}$/);
    assert.match(capabilities.runtimeInstanceId, /^[0-9a-f-]{20,}$/i);
    assert.equal(typeof capabilities.runtimeStartedAt, 'string');
    assert.deepEqual(capabilities.transport, ['streamable-http', 'legacy-sse']);
    assert.equal(capabilities.modules.mcpStreamableHttp, true);
    assert.equal(capabilities.modules.mcpSse, true);
    assert.equal(capabilities.tools.some((tool: any) => tool.name === 'get_recovery_handoff'), true);

    const diagnosticsResponse = await fetch(`${baseUrl}/api/diagnostics?previousContractVersion=${encodeURIComponent(capabilities.contractVersion)}&previousRuntimeInstanceId=${encodeURIComponent(capabilities.runtimeInstanceId)}&clientToolsVisible=false`);
    const diagnostics = await diagnosticsResponse.json() as any;
    assert.equal(diagnosticsResponse.status, 200);
    assert.equal(diagnostics.runtime.runtimeInstanceId, capabilities.runtimeInstanceId);
    assert.equal(diagnostics.runtimeDiagnosis.code, 'client-registry-desync');
    assert.equal(diagnostics.runtimeDiagnosis.recoverySurface, 'get_recovery_handoff');

    const driftResponse = await fetch(`${baseUrl}/api/diagnostics?previousContractVersion=${encodeURIComponent(capabilities.contractVersion)}&previousRuntimeInstanceId=previous-runtime&previousToolSurfaceIdentity=${'0'.repeat(64)}`);
    const drift = await driftResponse.json() as any;
    assert.equal(driftResponse.status, 200);
    assert.equal(drift.runtimeDiagnosis.code, 'tool-surface-changed');
  });
});
