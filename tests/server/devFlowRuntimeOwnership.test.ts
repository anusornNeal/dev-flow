import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-owner-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, '.devflow');

const ownership = await import('../../src/lib/devFlowRuntimeOwnership.js');

async function closeResult(result: any) {
  if (result?.status === 'owner') await result.release();
}

test('near-simultaneous launch claims exactly one owner and reuses it', async () => {
  const results = await Promise.all(Array.from({ length: 6 }, () => ownership.acquireDevFlowRuntimeOwnership({
    mode: 'all',
    appUrl: 'http://localhost:3000',
  })));
  try {
    const owners = results.filter((result: any) => result.status === 'owner');
    const reused = results.filter((result: any) => result.status === 'reused');
    assert.equal(owners.length, 1);
    assert.equal(reused.length, 5);
    assert.ok(reused.every((result: any) => result.owner.instanceId === owners[0].owner.instanceId));
  } finally {
    await Promise.all(results.map(closeResult));
  }
});

test('a verified owner may remain in starting state during slow setup without being stolen', async () => {
  const first = await ownership.acquireDevFlowRuntimeOwnership({
    mode: 'all',
    appUrl: 'http://localhost:3000',
    getLifecycleStatus: () => 'starting',
  });
  let duplicate: any;
  try {
    assert.equal(first.status, 'owner');
    if (first.status !== 'owner') return;

    const ownerPath = ownership.getDevFlowRuntimeOwnerPath();
    const recorded = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    recorded.startedAt = new Date(Date.now() - 60_000).toISOString();
    recorded.updatedAt = recorded.startedAt;
    fs.writeFileSync(ownerPath, JSON.stringify(recorded));

    duplicate = await ownership.acquireDevFlowRuntimeOwnership({ mode: 'all', appUrl: 'http://localhost:3000' });
    assert.equal(duplicate.status, 'reused');
    assert.equal(duplicate.owner.instanceId, first.owner.instanceId);
  } finally {
    await closeResult(duplicate);
    await closeResult(first);
  }
});

test('stale ownership is recovered even when the recorded PID is currently live', async () => {
  const lockDir = ownership.getDevFlowRuntimeOwnershipDir();
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
    version: 1,
    supervisor: 'start-all',
    instanceId: 'stale-owner',
    pid: process.pid,
    mode: 'all',
    appUrl: 'http://localhost:3000',
    controlPort: 9,
    controlToken: 'stale-token',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  let result: any;
  try {
    result = await ownership.acquireDevFlowRuntimeOwnership({ mode: 'all', appUrl: 'http://localhost:3000' });
    assert.equal(result.status, 'owner');
    assert.equal(result.recoveredStaleOwner, true);
    assert.notEqual(result.owner.instanceId, 'stale-owner');
  } finally {
    await closeResult(result);
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
});

test('unrelated port occupant fails closed without touching the occupant', async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await assert.rejects(
      ownership.assertDevFlowRuntimePortAvailable(address.port),
      (error: any) => error?.code === 'DEVFLOW_PORT_CONFLICT',
    );
    assert.equal(server.listening, true);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('loopback control shutdown accepts only the current opaque owner token', async () => {
  let shutdownCalls = 0;
  const result = await ownership.acquireDevFlowRuntimeOwnership({
    mode: 'server-only',
    appUrl: 'http://localhost:3000',
    onShutdown: () => { shutdownCalls += 1; },
  });
  try {
    assert.equal(result.status, 'owner');
    if (result.status !== 'owner') return;

    const denied = await fetch(`http://127.0.0.1:${result.owner.controlPort}/shutdown`, {
      method: 'POST',
      headers: { 'x-devflow-runtime-token': 'wrong-token' },
    });
    assert.equal(denied.status, 403);
    assert.equal(shutdownCalls, 0);

    const accepted = await fetch(`http://127.0.0.1:${result.owner.controlPort}/shutdown`, {
      method: 'POST',
      headers: { 'x-devflow-runtime-token': result.owner.controlToken },
    });
    assert.equal(accepted.status, 202);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(shutdownCalls, 1);
  } finally {
    await closeResult(result);
  }
});
