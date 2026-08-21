import test from 'node:test';
import assert from 'node:assert/strict';

const cacheService = await import('../../src/server/services/commandResultCacheService.js');
const { clearCommandResultCache, getCachedCommandResult, rememberCommandResult } = cacheService;

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
