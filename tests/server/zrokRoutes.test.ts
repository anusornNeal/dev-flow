import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { createPrivilegedApiAccessMiddleware } from '../../src/server/services/apiAccessPolicyService.js';
import { registerZrokRoutes } from '../../src/server/routes/zrok.js';
import type {
  ZrokRuntimeService,
  ZrokRuntimeStatus,
  ZrokTakeoverResult,
  ZrokSwitchHereResult,
} from '../../src/server/services/zrokRuntimeService.js';

const SAFE_STATUS: ZrokRuntimeStatus = {
  status: 'standby',
  statusLabel: 'Standby',
  baseUrl: 'https://zrok-test.example.test',
  mcpUrl: 'https://zrok-test.example.test/mcp',
  agentService: { state: 'running' },
  share: { state: 'remote-active', owner: 'remote' },
  publicReachability: { state: 'healthy', routedToThisMachine: false },
  latencyMs: 91,
  lastCheckedAt: '2026-08-16T14:00:00.000Z',
  message: 'Standby · active on another machine',
  actionability: { canRecheck: true, canTakeOver: true, canSwitchHere: false },
};

function makeRuntime(input: {
  status?: ZrokRuntimeStatus;
  takeover?: ZrokTakeoverResult;
  switchHere?: ZrokSwitchHereResult;
  throwStatus?: Error;
  throwTakeover?: Error;
  throwSwitchHere?: Error;
} = {}) {
  let statusCalls = 0;
  let takeoverCalls = 0;
  let switchHereCalls = 0;
  const runtime: ZrokRuntimeService = {
    async getStatus() {
      statusCalls += 1;
      if (input.throwStatus) throw input.throwStatus;
      return input.status || SAFE_STATUS;
    },
    async takeOver() {
      takeoverCalls += 1;
      if (input.throwTakeover) throw input.throwTakeover;
      return input.takeover || {
        ok: true,
        changed: true,
        message: 'Takeover complete.',
        status: { ...SAFE_STATUS, status: 'online', statusLabel: 'Online', share: { state: 'active', owner: 'local' }, publicReachability: { state: 'healthy', routedToThisMachine: true } },
      };
    },
    async switchHere() {
      switchHereCalls += 1;
      if (input.throwSwitchHere) throw input.throwSwitchHere;
      return input.switchHere || {
        ok: true,
        changed: true,
        message: 'Switch complete.',
        status: { ...SAFE_STATUS, status: 'online', statusLabel: 'Online', share: { state: 'active', owner: 'local' }, publicReachability: { state: 'healthy', routedToThisMachine: true } },
      };
    },
  };
  return {
    runtime,
    calls: {
      get status() { return statusCalls; },
      get takeover() { return takeoverCalls; },
      get switchHere() { return switchHereCalls; },
    },
  };
}

async function withServer(runtime: ZrokRuntimeService, run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use('/api', express.json());
  app.use('/api', createPrivilegedApiAccessMiddleware());
  registerZrokRoutes(app, { state: { countersCache: {} }, writeAgentLog: () => {} }, runtime);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind zrok route test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function remoteHeaders(extra: Record<string, string> = {}) {
  return {
    'x-forwarded-for': '203.0.113.24',
    ...extra,
  };
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test('remote GET /api/zrok/status remains read-only accessible and returns the bounded contract', async () => {
  const { runtime, calls } = makeRuntime();
  await withServer(runtime, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/zrok/status`, { headers: remoteHeaders() });
    const body = await response.json() as ZrokRuntimeStatus;
    assert.equal(response.status, 200);
    assert.equal(body.status, 'standby');
    assert.equal(body.mcpUrl, SAFE_STATUS.mcpUrl);
    assert.equal(body.share.owner, 'remote');
    assert.equal(calls.status, 1);
    assert.equal(calls.takeover, 0);
  });
});

test('remote POST /api/zrok/takeover is rejected before mutation when trusted API auth is not configured', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  delete process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  const { runtime, calls } = makeRuntime();
  try {
    await withServer(runtime, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/zrok/takeover`, {
        method: 'POST',
        headers: remoteHeaders({ 'content-type': 'application/json' }),
        body: '{}',
      });
      const body = await response.json() as any;
      assert.equal(response.status, 403);
      assert.equal(body.code, 'REMOTE_API_AUTH_REQUIRED');
      assert.equal(calls.takeover, 0);
    });
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});

test('remote POST /api/zrok/takeover accepts the existing trusted bearer policy', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'trusted-devflow-token';
  const { runtime, calls } = makeRuntime();
  try {
    await withServer(runtime, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/zrok/takeover`, {
        method: 'POST',
        headers: remoteHeaders({
          authorization: 'Bearer trusted-devflow-token',
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const body = await response.json() as ZrokTakeoverResult;
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status.status, 'online');
      assert.equal(calls.takeover, 1);
    });
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});

test('remote POST /api/zrok/switch-here accepts the existing trusted bearer policy', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'trusted-devflow-token';
  const { runtime, calls } = makeRuntime();
  try {
    await withServer(runtime, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/api/zrok/switch-here`, {
        method: 'POST',
        headers: remoteHeaders({
          authorization: 'Bearer trusted-devflow-token',
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const body = await response.json() as ZrokSwitchHereResult;
      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status.status, 'online');
      assert.equal(calls.switchHere, 1);
    });
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});

test('takeover blocked and terminal operation failures map to non-success HTTP statuses', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'trusted-devflow-token';
  const cases: Array<{ code: NonNullable<ZrokTakeoverResult['code']>; expected: number }> = [
    { code: 'ZROK_TAKEOVER_IN_PROGRESS', expected: 409 },
    { code: 'ZROK_TAKEOVER_REMOTE_FENCE_UNAVAILABLE', expected: 409 },
    { code: 'ZROK_TAKEOVER_STALE_OWNER', expected: 409 },
    { code: 'ZROK_TAKEOVER_REMOTE_FENCE_FAILED', expected: 502 },
    { code: 'ZROK_TAKEOVER_LOCAL_SHARE_FAILED', expected: 502 },
    { code: 'ZROK_TAKEOVER_VERIFY_FAILED', expected: 502 },
  ];
  try {
    for (const item of cases) {
      const { runtime } = makeRuntime({
        takeover: {
          ok: false,
          changed: false,
          code: item.code,
          message: 'Safe bounded failure.',
          status: SAFE_STATUS,
        },
      });
      await withServer(runtime, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/zrok/takeover`, {
          method: 'POST',
          headers: remoteHeaders({
            authorization: 'Bearer trusted-devflow-token',
            'content-type': 'application/json',
          }),
          body: '{}',
        });
        assert.equal(response.status, item.expected, item.code);
      });
    }
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});

test('switchHere blocked and terminal operation failures map to non-success HTTP statuses', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'trusted-devflow-token';
  const cases: Array<{ code: NonNullable<ZrokSwitchHereResult['code']>; expected: number }> = [
    { code: 'ZROK_SWITCH_IN_PROGRESS', expected: 409 },
    { code: 'ZROK_SWITCH_NOT_AVAILABLE', expected: 409 },
    { code: 'ZROK_SWITCH_STALE_OWNER', expected: 409 },
    { code: 'ZROK_SWITCH_DELETE_FAILED', expected: 502 },
    { code: 'ZROK_SWITCH_LOCAL_SHARE_FAILED', expected: 502 },
    { code: 'ZROK_SWITCH_VERIFY_FAILED', expected: 502 },
  ];
  try {
    for (const item of cases) {
      const { runtime } = makeRuntime({
        switchHere: {
          ok: false,
          changed: false,
          code: item.code,
          message: 'Safe bounded failure.',
          status: SAFE_STATUS,
        },
      });
      await withServer(runtime, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/api/zrok/switch-here`, {
          method: 'POST',
          headers: remoteHeaders({
            authorization: 'Bearer trusted-devflow-token',
            'content-type': 'application/json',
          }),
          body: '{}',
        });
        assert.equal(response.status, item.expected, item.code);
      });
    }
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});

test('route error handling never reflects thrown secret-bearing errors', async () => {
  const previous = process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
  process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'trusted-devflow-token';
  const secret = 'zrok-account-secret-never-return-this';
  const { runtime } = makeRuntime({
    throwStatus: new Error(`status failed with ${secret}`),
    throwTakeover: new Error(`takeover failed with ${secret}`),
    throwSwitchHere: new Error(`switchHere failed with ${secret}`),
  });
  try {
    await withServer(runtime, async (baseUrl) => {
      const statusResponse = await fetch(`${baseUrl}/api/zrok/status`, { headers: remoteHeaders() });
      const statusText = await statusResponse.text();
      assert.equal(statusResponse.status, 500);
      assert.equal(statusText.includes(secret), false);
      assert.match(statusText, /ZROK_STATUS_FAILED/);

      const takeoverResponse = await fetch(`${baseUrl}/api/zrok/takeover`, {
        method: 'POST',
        headers: remoteHeaders({
          authorization: 'Bearer trusted-devflow-token',
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const takeoverText = await takeoverResponse.text();
      assert.equal(takeoverResponse.status, 500);
      assert.equal(takeoverText.includes(secret), false);
      assert.match(takeoverText, /ZROK_TAKEOVER_FAILED/);

      const switchResponse = await fetch(`${baseUrl}/api/zrok/switch-here`, {
        method: 'POST',
        headers: remoteHeaders({
          authorization: 'Bearer trusted-devflow-token',
          'content-type': 'application/json',
        }),
        body: '{}',
      });
      const switchText = await switchResponse.text();
      assert.equal(switchResponse.status, 500);
      assert.equal(switchText.includes(secret), false);
      assert.match(switchText, /ZROK_SWITCH_FAILED/);
    });
  } finally {
    restoreEnv('DEVFLOW_TRUSTED_REMOTE_TOKEN', previous);
  }
});
