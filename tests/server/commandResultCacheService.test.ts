import test from 'node:test';
import assert from 'node:assert/strict';

const cacheService = await import('../../src/server/services/commandResultCacheService.js');
const { classifyCommandResultCacheMiss, classifyCommandResultIdentityMismatch, clearCommandResultCache, getCachedCommandResult, rememberCommandResult } = cacheService;

test('bounded reusable evidence is not invalidated by wall-clock TTL', () => {
  clearCommandResultCache();
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    rememberCommandResult('bounded-evidence', { ok: true }, 1_000, {
      reusable: true,
      retention: 'bounded',
      sourceConsumerId: 'source-consumer',
    });
    now += 60_000;

    const cached = getCachedCommandResult<{ ok: boolean }>('bounded-evidence', 'later-consumer');
    assert.equal(cached?.value.ok, true);
    assert.equal(cached?.evidence?.reusable, true);
    assert.deepEqual(cached?.evidence?.consumers.sort(), ['later-consumer', 'source-consumer']);
  } finally {
    Date.now = originalNow;
    clearCommandResultCache();
  }
});

test('cache miss diagnostics classify semantic evidence drift without exposing raw identity values', () => {
  clearCommandResultCache();
  const baseIdentity = {
    repositoryScope: 'project:diagnostics',
    reusePolicy: 'effective-input' as const,
    semanticKey: 'semantic-a',
    commandConfigFingerprint: 'config-a',
    affectedInputFingerprint: 'input-a',
    dependencyFingerprint: 'dependency-a',
    environmentFingerprint: 'environment-a',
    cwd: '.',
    timeoutMs: 120_000,
    maxOutputBytes: 12_000,
    responseMode: 'standard' as const,
    evidenceLineageToken: 'project-rules:0',
  };
  rememberCommandResult('diagnostic-source', { ok: true }, undefined, {
    reusable: true,
    retention: 'bounded',
    reuseIdentity: baseIdentity,
  });

  assert.equal(classifyCommandResultCacheMiss({ ...baseIdentity, affectedInputFingerprint: 'input-b' }), 'AFFECTED_INPUT_CHANGED');
  assert.equal(classifyCommandResultCacheMiss({ ...baseIdentity, dependencyFingerprint: 'dependency-b' }), 'DEPENDENCY_CHANGED');
  assert.equal(classifyCommandResultCacheMiss({ ...baseIdentity, environmentFingerprint: 'environment-b' }), 'ENVIRONMENT_CHANGED');
  clearCommandResultCache();
});

test('shared identity mismatch classifier fails closed for exact-revision FULL evidence', () => {
  const baseIdentity = {
    repositoryScope: 'project:durable-diagnostics',
    reusePolicy: 'exact-revision' as const,
    repoRevision: 'rev-a',
    semanticKey: 'verify',
    coverageScope: 'full' as const,
    targets: [],
    commandConfigFingerprint: 'config-a',
    affectedInputFingerprint: 'input-a',
    dependencyFingerprint: 'dependency-a',
    environmentFingerprint: 'environment-a',
    cwd: '.',
    timeoutMs: 120_000,
    maxOutputBytes: 12_000,
    responseMode: 'standard' as const,
    evidenceLineageToken: 'project-rules:0',
  };

  assert.equal(classifyCommandResultIdentityMismatch([baseIdentity], { ...baseIdentity, repoRevision: 'rev-b' }), 'CANDIDATE_AUTHORITY_CHANGED');
  assert.equal(classifyCommandResultIdentityMismatch([baseIdentity], { ...baseIdentity, coverageScope: 'broad' }), 'COVERAGE_SCOPE_CHANGED');
  assert.equal(classifyCommandResultIdentityMismatch([baseIdentity], { ...baseIdentity, commandConfigFingerprint: 'config-b' }), 'COMMAND_CONFIG_CHANGED');
  assert.equal(classifyCommandResultIdentityMismatch([baseIdentity], { ...baseIdentity, evidenceLineageToken: 'project-rules:1' }), 'PROJECT_RULES_CHANGED');
});

test('ordinary command results retain TTL expiry semantics', () => {
  clearCommandResultCache();
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    rememberCommandResult('ttl-result', { ok: true }, 1_000);
    now += 1_001;
    assert.equal(getCachedCommandResult('ttl-result'), null);
  } finally {
    Date.now = originalNow;
    clearCommandResultCache();
  }
});
