import crypto from 'crypto';
import { DevFlowApiError } from './api';

export class ResourceBusyError extends DevFlowApiError {
  public resourceId: string;
  constructor(message: string, resourceId: string) {
    super(409, {
      code: 'RESOURCE_BUSY',
      message,
      retryable: true,
      affectedId: resourceId,
    });
    this.name = 'ResourceBusyError';
    this.resourceId = resourceId;
  }
}

export class IdempotencyConflictError extends DevFlowApiError {
  constructor(key: string) {
    super(409, {
      code: 'IDEMPOTENCY_CONFLICT',
      message: `Idempotency key '${key}' was already used for a different request.`,
      retryable: false,
      affectedId: key,
    });
    this.name = 'IdempotencyConflictError';
  }
}

interface LockEntry {
  token: string;
  timestamp: number;
}

// In-memory lock store with timestamps and ownership tokens
const activeLocks = new Map<string, LockEntry>();
const LOCK_TTL_MS = 5 * 60 * 1000;

/**
 * Attempt to acquire a lock for a given resource ID.
 * Throws ResourceBusyError if already locked and not expired (5 min TTL).
 * Returns the lock ownership token.
 */
export function acquireLock(resourceId: string): string {
  const now = Date.now();
  const lock = activeLocks.get(resourceId);
  if (lock !== undefined && (now - lock.timestamp < LOCK_TTL_MS)) {
    throw new ResourceBusyError(`Resource ${resourceId} is currently locked by another operation. Please try again.`, resourceId);
  }
  const token = crypto.randomUUID();
  activeLocks.set(resourceId, { token, timestamp: now });
  return token;
}

/**
 * Release a previously acquired lock only if the token matches.
 */
export function releaseLock(resourceId: string, token: string): void {
  const lock = activeLocks.get(resourceId);
  if (lock && lock.token === token) {
    activeLocks.delete(resourceId);
  }
}

/**
 * Execute an async operation with a lock.
 */
export async function withLock<T>(resourceId: string, operation: () => Promise<T>): Promise<T> {
  const token = acquireLock(resourceId);
  try {
    return await operation();
  } finally {
    releaseLock(resourceId, token);
  }
}

export interface IdempotencyEntry {
  promise: Promise<any>;
  status: 'pending' | 'resolved';
  result?: any;
  timestamp: number;
  fingerprint?: string;
}

// In-memory idempotency store
// Keeps keys for 10 minutes to prevent duplicate processing of the same request
const idempotencyCache = new Map<string, IdempotencyEntry>();
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

interface PendingControls {
  resolve: (value: any) => void;
  reject: (err: any) => void;
}
const pendingControlsMap = new Map<string, PendingControls>();

export function cleanIdempotencyCache(): void {
  const now = Date.now();
  
  // Prune expired active locks
  for (const [key, lock] of activeLocks.entries()) {
    if (now - lock.timestamp >= LOCK_TTL_MS) {
      activeLocks.delete(key);
    }
  }

  for (const [key, value] of idempotencyCache.entries()) {
    if (now - value.timestamp > IDEMPOTENCY_TTL_MS) {
      if (value.status === 'resolved') {
        idempotencyCache.delete(key);
        pendingControlsMap.delete(key);
      } else if (value.status === 'pending') {
        rejectPendingIdempotency(key, new Error('Idempotency timeout exceeded'));
      }
    }
  }
}

let cleanupInterval: NodeJS.Timeout | null = null;

// Run cleanup every 5 minutes by default
export function startIdempotencyCleanupInterval(intervalMs: number = 5 * 60 * 1000): void {
  stopIdempotencyCleanupInterval();
  cleanupInterval = setInterval(cleanIdempotencyCache, intervalMs);
  if (cleanupInterval && typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }
}

export function stopIdempotencyCleanupInterval(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}

// Start default interval
startIdempotencyCleanupInterval(5 * 60 * 1000);

export function createPendingIdempotency(key: string): Promise<any> {
  return createPendingIdempotencyWithFingerprint(key);
}

export function createPendingIdempotencyWithFingerprint(key: string, fingerprint?: string): Promise<any> {
  let resolveFn!: (value: any) => void;
  let rejectFn!: (reason?: any) => void;
  const promise = new Promise<any>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });

  // Attach a dummy catch handler to prevent unhandledRejection if the operation fails
  promise.catch(() => {});

  idempotencyCache.set(key, {
    promise,
    status: 'pending',
    timestamp: Date.now(),
    fingerprint,
  });

  pendingControlsMap.set(key, {
    resolve: resolveFn,
    reject: rejectFn
  });

  return promise;
}

export function resolvePendingIdempotency(key: string, result: any): void {
  const existing = idempotencyCache.get(key);
  const controls = pendingControlsMap.get(key);
  if (controls) {
    controls.resolve(result);
    pendingControlsMap.delete(key);
  }
  idempotencyCache.set(key, {
    promise: Promise.resolve(result),
    status: 'resolved',
    result,
    timestamp: Date.now(),
    fingerprint: existing?.fingerprint,
  });
}

export function rejectPendingIdempotency(key: string, error: any): void {
  const controls = pendingControlsMap.get(key);
  if (controls) {
    controls.reject(error);
    pendingControlsMap.delete(key);
  }
  idempotencyCache.delete(key);
}

/**
 * Check if an idempotency key was already processed.
 * If yes, returns the previous result or the pending promise.
 * If no, returns undefined.
 */
function assertFingerprintCompatible(key: string, entry: IdempotencyEntry, fingerprint?: string): void {
  if (entry.fingerprint && fingerprint && entry.fingerprint !== fingerprint) {
    throw new IdempotencyConflictError(key);
  }
}

export function getIdempotencyResult(key: string, fingerprint?: string): any {
  const entry = idempotencyCache.get(key);
  if (entry) {
    assertFingerprintCompatible(key, entry, fingerprint);
    if (entry.status === 'pending') {
      return entry.promise;
    }
    return entry.result;
  }
  return undefined;
}

export function setIdempotencyResult(key: string, result: any, fingerprint?: string): void {
  idempotencyCache.set(key, {
    promise: Promise.resolve(result),
    status: 'resolved',
    result,
    timestamp: Date.now(),
    fingerprint,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'idempotencyKey')
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function buildIdempotencyFingerprint(method: string, path: string, payload: unknown): string {
  const hash = crypto
    .createHash('sha256')
    .update(stableStringify(payload))
    .digest('hex');
  return `${method.toUpperCase()} ${path} ${hash}`;
}

export async function withIdempotency<T>(
  key: string | undefined | null,
  fingerprintOrOperation: string | (() => Promise<T>),
  maybeOperation?: () => Promise<T>,
): Promise<T> {
  const fingerprint = typeof fingerprintOrOperation === 'string' ? fingerprintOrOperation : undefined;
  const operation = typeof fingerprintOrOperation === 'function' ? fingerprintOrOperation : maybeOperation;
  if (!operation) {
    throw new Error('withIdempotency requires an operation.');
  }

  if (!key) {
    return operation();
  }

  const entry = idempotencyCache.get(key);
  if (entry) {
    assertFingerprintCompatible(key, entry, fingerprint);
    if (entry.status === 'pending') {
      return entry.promise;
    }
    return entry.result;
  }

  const promise = createPendingIdempotencyWithFingerprint(key, fingerprint);
  try {
    const result = await operation();
    resolvePendingIdempotency(key, result);
    return result;
  } catch (error) {
    rejectPendingIdempotency(key, error);
    throw error;
  }
}
