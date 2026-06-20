import test from 'node:test';
import assert from 'node:assert/strict';
import { DevFlowApiError } from '../../src/server/services/api.js';

// We import the lock and idempotency service
import {
  acquireLock,
  releaseLock,
  ResourceBusyError,
  withLock,
  withIdempotency,
  getIdempotencyResult,
  setIdempotencyResult,
  createPendingIdempotency,
  resolvePendingIdempotency,
  rejectPendingIdempotency,
  startIdempotencyCleanupInterval,
  stopIdempotencyCleanupInterval,
  cleanIdempotencyCache,
} from '../../src/server/services/lockAndIdempotencyService.js';

test('ResourceBusyError shape and properties', () => {
  const err = new ResourceBusyError('Busy message', 'resource-1');
  assert.ok(err instanceof DevFlowApiError);
  assert.equal(err.status, 409);
  assert.equal(err.payload.code, 'RESOURCE_BUSY');
  assert.equal(err.payload.message, 'Busy message');
  assert.equal(err.payload.retryable, true);
  assert.equal(err.payload.affectedId, 'resource-1');
  assert.equal(err.resourceId, 'resource-1');
});

test('Lock acquire and release behaviors', async () => {
  const resource = 'resource-lock-test';

  // First acquire should succeed
  const token = acquireLock(resource);
  assert.ok(typeof token === 'string');

  // Second acquire should throw ResourceBusyError
  assert.throws(() => {
    acquireLock(resource);
  }, (err: any) => {
    return err instanceof ResourceBusyError && err.resourceId === resource;
  });

  // Release and re-acquire should succeed
  releaseLock(resource, token);
  const token2 = acquireLock(resource);
  releaseLock(resource, token2);
});

test('Lock TTL (5 minutes) auto-expiry', () => {
  const resource = 'resource-ttl-test';

  const originalNow = Date.now;
  let mockTime = 1000000000000;
  Date.now = () => mockTime;

  let currentToken: string | null = null;
  try {
    // Acquire lock at mockTime
    currentToken = acquireLock(resource);

    // Try to acquire immediately, should throw
    assert.throws(() => acquireLock(resource), ResourceBusyError);

    // Advance time by 4 minutes (240000ms), should still be locked
    mockTime += 4 * 60 * 1000;
    assert.throws(() => acquireLock(resource), ResourceBusyError);

    // Advance time past 5 minutes, should expire and allow acquiring again
    mockTime += 1 * 60 * 1000 + 1000; // Total 5 min 1 sec
    currentToken = acquireLock(resource); // Should succeed and update timestamp
    
    // Immediate try should now throw again
    assert.throws(() => acquireLock(resource), ResourceBusyError);
  } finally {
    Date.now = originalNow;
    if (currentToken) {
      releaseLock(resource, currentToken);
    }
  }
});

test('withIdempotency returns cached resolved result', async () => {
  const key = 'idemp-key-resolved';
  let callCount = 0;
  const operation = async () => {
    callCount++;
    return { val: 'success-1' };
  };

  const res1 = await withIdempotency(key, operation);
  const res2 = await withIdempotency(key, operation);

  assert.deepEqual(res1, { val: 'success-1' });
  assert.deepEqual(res2, { val: 'success-1' });
  assert.equal(callCount, 1);
});

test('withIdempotency allows retries on operation failure', async () => {
  const key = 'idemp-key-failure';
  let callCount = 0;
  const operation = async () => {
    callCount++;
    if (callCount === 1) {
      throw new Error('temporary failure');
    }
    return { val: 'success-after-retry' };
  };

  // First call fails
  await assert.rejects(async () => {
    await withIdempotency(key, operation);
  }, /temporary failure/);

  // Cache entry should be deleted, so second call retries and succeeds
  const res2 = await withIdempotency(key, operation);
  assert.deepEqual(res2, { val: 'success-after-retry' });
  assert.equal(callCount, 2);
});

test('withIdempotency concurrency - duplicate calls await same pending promise', async () => {
  const key = 'idemp-key-concurrency';
  let callCount = 0;
  
  let resolveOp!: (val: any) => void;
  const promise = new Promise((resolve) => {
    resolveOp = resolve;
  });

  const operation = async () => {
    callCount++;
    await promise;
    return { value: 42 };
  };

  // Start two concurrent operations
  const op1 = withIdempotency(key, operation);
  const op2 = withIdempotency(key, operation);

  // Resolve the operation
  resolveOp({ value: 42 });

  const [res1, res2] = await Promise.all([op1, op2]);
  assert.deepEqual(res1, { value: 42 });
  assert.deepEqual(res2, { value: 42 });
  assert.equal(callCount, 1);
});

test('Idempotency cleanup interval methods', () => {
  // We can start and stop the interval to verify it doesn't throw errors
  stopIdempotencyCleanupInterval();
  startIdempotencyCleanupInterval(100);
  stopIdempotencyCleanupInterval();
});

test('releaseLock with incorrect token does not release the lock', () => {
  const resource = 'resource-incorrect-token-test';
  
  // Acquire the lock, getting a token
  const correctToken = acquireLock(resource);
  assert.ok(typeof correctToken === 'string');
  
  // Attempt to release with an incorrect token
  releaseLock(resource, 'incorrect-token');
  
  // The lock should still be held; acquiring again should throw ResourceBusyError
  assert.throws(() => {
    acquireLock(resource);
  }, ResourceBusyError);
  
  // Releasing with the correct token should release it
  releaseLock(resource, correctToken);
  
  // Now acquiring it should succeed
  const newToken = acquireLock(resource);
  assert.ok(typeof newToken === 'string');
  
  // Cleanup
  releaseLock(resource, newToken);
});

test('cleanIdempotencyCache cleans up both resolved and pending entries past TTL', async () => {
  const pendingKey = 'clean-pending-key';
  const resolvedKey = 'clean-resolved-key';
  
  const originalNow = Date.now;
  let mockTime = 1000000000000;
  Date.now = () => mockTime;

  try {
    // 1. Create a pending entry
    createPendingIdempotency(pendingKey);
    
    // 2. Create a resolved entry
    setIdempotencyResult(resolvedKey, { status: 'ok' });
    
    // Both should exist
    assert.notEqual(getIdempotencyResult(pendingKey), undefined);
    assert.deepEqual(getIdempotencyResult(resolvedKey), { status: 'ok' });
    
    // Advance time past the 10 minute TTL (11 minutes = 11 * 60 * 1000)
    mockTime += 11 * 60 * 1000;
    
    // Call cleanIdempotencyCache
    cleanIdempotencyCache();
    
    // The pending entry should be deleted because it timed out
    assert.equal(getIdempotencyResult(pendingKey), undefined);
    
    // The resolved entry should have been cleaned up
    assert.equal(getIdempotencyResult(resolvedKey), undefined);
  } finally {
    Date.now = originalNow;
  }
});
