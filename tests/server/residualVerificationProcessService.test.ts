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
  reloadResidualVerificationProcessStateForTests,
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

test('exhausted destructive retries still reconcile when the tracked process later disappears', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 240_000;
  registerResidualVerificationProcess({
    pid: 999,
    platform: 'win32',
    identityHash: 'identity-999',
    trigger: 'timeout',
    now: base,
  });

  let destructiveAttempts = 0;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    reapResidualVerificationProcesses({
      now: base + attempt * 180_000,
      captureIdentity: () => ({ supported: true, exists: true, pid: 999, identityHash: 'identity-999' }),
      terminateTree: () => {
        destructiveAttempts += 1;
        return {
          attempted: true,
          treeTermination: true,
          terminated: false,
          confirmed: false,
          identityHash: 'identity-999',
          reason: 'terminator-failed',
        };
      },
    });
  }
  assert.equal(destructiveAttempts, 12);
  assert.equal(getResidualVerificationResourceSnapshot(base + 12 * 180_000).count, 1);

  let observationProbes = 0;
  const cleared = reapResidualVerificationProcesses({
    now: base + 20 * 180_000,
    captureIdentity: () => {
      observationProbes += 1;
      return { supported: true, exists: false, pid: 999, reason: 'process-not-found' };
    },
    terminateTree: () => {
      throw new Error('observation-only reconciliation must not perform destructive termination');
    },
  });

  assert.equal(observationProbes, 1);
  assert.equal(cleared.count, 0);
});

test('observation-only debt survives reload, backs off, and never retries destructive termination', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 300_000;
  registerResidualVerificationProcess({
    pid: 1001,
    platform: 'win32',
    identityHash: 'identity-1001',
    trigger: 'cancel',
    now: base,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    reapResidualVerificationProcesses({
      now: base + attempt * 180_000,
      captureIdentity: () => ({ supported: true, exists: true, pid: 1001, identityHash: 'identity-1001' }),
      terminateTree: () => ({
        attempted: true,
        treeTermination: true,
        terminated: false,
        confirmed: false,
        identityHash: 'identity-1001',
        reason: 'terminator-failed',
      }),
    });
  }

  const exhausted = getResidualVerificationResourceSnapshot(base + 12 * 180_000);
  assert.equal(exhausted.count, 1);
  assert.equal(exhausted.attempts, 12);
  assert.equal(exhausted.remediationActiveCount, 0);
  assert.equal(exhausted.observationOnlyCount, 1);
  assert.equal(exhausted.states['observation-only'], 1);

  const stateFile = path.join(runtimeRoot, 'residual-verification-processes.json');
  const persistedBeforeReload = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { records: Array<{ attempts: number; nextAttemptAt: number; state: string }> };
  const dueAt = persistedBeforeReload.records[0].nextAttemptAt;
  assert.equal(persistedBeforeReload.records[0].attempts, 12);
  assert.equal(persistedBeforeReload.records[0].state, 'observation-only');

  const reloaded = reloadResidualVerificationProcessStateForTests();
  assert.equal(reloaded.observationOnlyCount, 1);
  assert.equal(reloaded.attempts, 12);

  let probes = 0;
  let destructiveAttempts = 0;
  reapResidualVerificationProcesses({
    now: dueAt - 1,
    captureIdentity: () => {
      probes += 1;
      return { supported: true, exists: true, pid: 1001, identityHash: 'identity-1001' };
    },
    terminateTree: () => {
      destructiveAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: false, confirmed: false };
    },
  });
  assert.equal(probes, 0, 'persisted observation cadence must survive reload');

  const probeFailure = reapResidualVerificationProcesses({
    now: dueAt,
    captureIdentity: () => {
      probes += 1;
      return { supported: false, exists: false, pid: 1001, reason: 'probe-failed' };
    },
    terminateTree: () => {
      destructiveAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: false, confirmed: false };
    },
  });
  assert.equal(probes, 1);
  assert.equal(destructiveAttempts, 0);
  assert.equal(probeFailure.count, 1);
  assert.equal(probeFailure.attempts, 12);
  assert.equal(probeFailure.observationOnlyCount, 1);

  const persistedAfterFailure = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { records: Array<{ nextAttemptAt: number }> };
  const nextDueAt = persistedAfterFailure.records[0].nextAttemptAt;
  assert.equal(nextDueAt > dueAt, true);

  const stillAlive = reapResidualVerificationProcesses({
    now: nextDueAt,
    captureIdentity: () => ({ supported: true, exists: true, pid: 1001, identityHash: 'identity-1001' }),
    terminateTree: () => {
      destructiveAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: false, confirmed: false };
    },
  });
  assert.equal(destructiveAttempts, 0);
  assert.equal(stillAlive.count, 1);
  assert.equal(stillAlive.attempts, 12);
  assert.equal(stillAlive.observationOnlyCount, 1);
});

test('observation-only debt clears on PID reuse without killing the replacement process', () => {
  clearResidualVerificationProcessStateForTests();
  const base = Date.now() + 360_000;
  registerResidualVerificationProcess({
    pid: 1002,
    platform: 'win32',
    identityHash: 'original-1002',
    trigger: 'timeout',
    now: base,
  });

  for (let attempt = 0; attempt < 12; attempt += 1) {
    reapResidualVerificationProcesses({
      now: base + attempt * 180_000,
      captureIdentity: () => ({ supported: true, exists: true, pid: 1002, identityHash: 'original-1002' }),
      terminateTree: () => ({
        attempted: true,
        treeTermination: true,
        terminated: false,
        confirmed: false,
        identityHash: 'original-1002',
        reason: 'terminator-failed',
      }),
    });
  }

  const stateFile = path.join(runtimeRoot, 'residual-verification-processes.json');
  const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { records: Array<{ nextAttemptAt: number }> };
  let destructiveAttempts = 0;
  const cleared = reapResidualVerificationProcesses({
    now: persisted.records[0].nextAttemptAt,
    captureIdentity: () => ({ supported: true, exists: true, pid: 1002, identityHash: 'replacement-1002' }),
    terminateTree: () => {
      destructiveAttempts += 1;
      return { attempted: true, treeTermination: true, terminated: true, confirmed: true };
    },
  });

  assert.equal(destructiveAttempts, 0);
  assert.equal(cleared.count, 0);
});
