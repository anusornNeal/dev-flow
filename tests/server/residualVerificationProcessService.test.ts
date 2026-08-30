import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-residual-process-'));
const previousRuntimeDir = process.env.DEVFLOW_RUNTIME_DIR;
process.env.DEVFLOW_RUNTIME_DIR = runtimeRoot;

const residuals = await import('../../src/server/services/residualVerificationProcessService.js');
const {
  clearResidualVerificationProcessStateForTests,
  getResidualVerificationResourceSnapshot,
  reapResidualVerificationProcesses,
  registerResidualVerificationProcess,
} = residuals;

after(() => {
  clearResidualVerificationProcessStateForTests();
  if (previousRuntimeDir === undefined) delete process.env.DEVFLOW_RUNTIME_DIR;
  else process.env.DEVFLOW_RUNTIME_DIR = previousRuntimeDir;
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
});

test('residual verification debt persists after unconfirmed teardown and clears after confirmed cleanup', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 60_000;
  registerResidualVerificationProcess({
    pid: 501,
    platform: 'win32',
    identityHash: 'identity-501',
    trigger: 'timeout',
    now: base,
    resourceEstimate: { cpuRatio: 0.3, memoryBytes: 256 * 1024 ** 2, processCount: 1 },
  });
  assert.equal(getResidualVerificationResourceSnapshot(base).count, 1);
  assert.equal(fs.existsSync(path.join(runtimeRoot, 'residual-verification-processes.json')), true);

  let teardownAttempts = 0;
  const retained = reapResidualVerificationProcesses({
    now: base,
    captureIdentity: () => ({ supported: true, exists: true, pid: 501, identityHash: 'identity-501' }),
    terminateTree: () => {
      teardownAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: false, confirmed: false, identityHash: 'identity-501', reason: 'terminator-failed' };
    },
  });
  assert.equal(teardownAttempts, 1);
  assert.equal(retained.count, 1);
  assert.equal(retained.attempts, 1);
  assert.equal(retained.states['termination-unconfirmed'], 1);

  const cleared = reapResidualVerificationProcesses({
    now: base + 2_000,
    captureIdentity: () => ({ supported: true, exists: true, pid: 501, identityHash: 'identity-501' }),
    terminateTree: () => ({ attempted: true, treeTermination: true, terminated: true, confirmed: true, identityHash: 'identity-501' }),
  });
  assert.equal(cleared.count, 0);
  assert.equal(cleared.resourceEstimate.processCount, 0);
});

test('residual reaper refuses destructive cleanup after PID identity reuse', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 120_000;
  registerResidualVerificationProcess({
    pid: 777,
    platform: 'win32',
    identityHash: 'original-777',
    trigger: 'cancel',
    now: base,
    resourceEstimate: { cpuRatio: 0.1, memoryBytes: 64 * 1024 ** 2, processCount: 1 },
  });

  let teardownAttempts = 0;
  const snapshot = reapResidualVerificationProcesses({
    now: base,
    captureIdentity: () => ({ supported: true, exists: true, pid: 777, identityHash: 'replacement-777' }),
    terminateTree: () => {
      teardownAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: true, confirmed: true };
    },
  });

  assert.equal(teardownAttempts, 0);
  assert.equal(snapshot.count, 0, 'PID reuse proves the original tracked process is gone, so its debt can be released safely');
});

test('residual reaper clears debt without teardown when the tracked process is already absent', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 180_000;
  registerResidualVerificationProcess({ pid: 888, platform: 'win32', identityHash: 'identity-888', trigger: 'timeout', now: base });
  let teardownAttempts = 0;
  const snapshot = reapResidualVerificationProcesses({
    now: base,
    captureIdentity: () => ({ supported: true, exists: false, pid: 888, reason: 'process-not-found' }),
    terminateTree: () => {
      teardownAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: true, confirmed: true };
    },
  });
  assert.equal(teardownAttempts, 0);
  assert.equal(snapshot.count, 0);
});
