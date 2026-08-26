import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const blockers = await import('../../src/server/services/verificationBlockerEvidenceService.js');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-blocker-evidence-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'Feature.kt'), 'class Feature\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'FakeUserRepository.kt'), 'class FakeUserRepository\n', 'utf8');
  return root;
}

const COVERAGE = {
  key: 'ignored-by-service',
  command: 'test',
  semanticKey: 'gradle:testDebugUnitTest',
  commandConfigFingerprint: 'config-a',
  affectedInputFingerprint: 'owned-a',
  affectedInputPaths: ['src/Feature.kt'],
  dependencyFingerprint: 'deps-a',
  environmentFingerprint: 'env-a',
  platform: 'win32',
  arch: 'x64',
  runtime: 'node-24',
} as const;

function failure(pathValue = 'src/FakeUserRepository.kt', message = 'Unresolved reference verifyPassword') {
  return `> Task :compileDebugUnitTestKotlin FAILED\ne: ${pathValue}:42:17 ${message}\nCompilation failed`;
}

test('records and reuses only a proven unrelated blocker with stable blocker-relevant provenance', () => {
  blockers.clearVerificationBlockerEvidence();
  const root = fixture();
  const recorded = blockers.classifyAndRememberVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/Feature.kt'],
    stderr: failure(),
  });
  assert.ok(recorded);
  assert.equal(recorded.phase, 'test-compile');
  assert.deepEqual(recorded.blockerPaths, ['src/FakeUserRepository.kt']);
  assert.match(recorded.failureSignature, /^[a-f0-9]{64}$/);

  const reused = blockers.findReusableVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/Feature.kt'],
  });
  assert.equal(reused?.reused, true);
  assert.equal(reused?.evidence.id, recorded.id);

  assert.equal(blockers.findReusableVerificationBlocker({
    repoRoot: root,
    coverage: { ...COVERAGE, environmentFingerprint: 'env-b' },
    taskOwnedPaths: ['src/Feature.kt'],
  }), null);
  assert.equal(blockers.findReusableVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/FakeUserRepository.kt'],
  }), null);
  assert.equal(blockers.findReusableVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/Feature.kt'],
    failureSignature: 'different-signature',
  }), null);

  fs.writeFileSync(path.join(root, 'src', 'FakeUserRepository.kt'), 'class FakeUserRepository { fun verifyPassword() = true }\n', 'utf8');
  assert.equal(blockers.findReusableVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/Feature.kt'],
  }), null, 'changing the blocker source forces the real check to run again');
});

test('never records task-owned failures or incomplete provenance', () => {
  blockers.clearVerificationBlockerEvidence();
  const root = fixture();
  assert.equal(blockers.classifyAndRememberVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/FakeUserRepository.kt'],
    stderr: failure(),
  }), null);

  assert.equal(blockers.classifyAndRememberVerificationBlocker({
    repoRoot: root,
    coverage: { ...COVERAGE, environmentFingerprint: undefined } as any,
    taskOwnedPaths: ['src/Feature.kt'],
    stderr: failure(),
  }), null);

  assert.equal(blockers.classifyAndRememberVerificationBlocker({
    repoRoot: root,
    coverage: COVERAGE,
    taskOwnedPaths: ['src/Feature.kt'],
    stderr: 'AssertionError: expected 1 actual 2',
  }), null, 'failures without bounded blocker source evidence remain ordinary failures');
});

test('failure signature normalization is stable for location-only noise and changes for material failures', () => {
  const root = fixture();
  const first = blockers.normalizeVerificationFailureSignature(failure('src/FakeUserRepository.kt'), root);
  const locationNoise = blockers.normalizeVerificationFailureSignature(failure('src/FakeUserRepository.kt').replace(':42:17', ':99:3'), root);
  const changed = blockers.normalizeVerificationFailureSignature(failure('src/FakeUserRepository.kt', 'Type mismatch: expected String actual Int'), root);
  assert.equal(first, locationNoise);
  assert.notEqual(first, changed);
});
