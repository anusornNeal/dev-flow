export type ZrokRateLimitSource = 'public' | 'control' | 'local-agent';

export interface ZrokRateLimitInfo {
  source: ZrokRateLimitSource;
  firstObservedAt: string;
  lastObservedAt: string;
  nextAttemptAt: string;
  retryAfterMs: number;
  observedCount: number;
}

export interface ZrokRateLimitTrackerOptions {
  now?: () => number;
  random?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxBackoffAttempts?: number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 60_000;
const DEFAULT_MAX_BACKOFF_ATTEMPTS = 6;
const MIN_DELAY_MS = 250;
const MAX_OBSERVED_COUNT = 999;

function boundedInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function parseZrokRetryAfterMs(
  value: string | null | undefined,
  nowMs: number,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
): number | null {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const numericSeconds = Number(raw);
  if (Number.isFinite(numericSeconds) && numericSeconds >= 0) {
    return boundedInteger(numericSeconds * 1_000, MIN_DELAY_MS, maxDelayMs);
  }

  const dateMs = Date.parse(raw);
  if (!Number.isFinite(dateMs)) return null;
  return boundedInteger(dateMs - nowMs, MIN_DELAY_MS, maxDelayMs);
}

export function createZrokRateLimitTracker(
  source: ZrokRateLimitSource,
  options: ZrokRateLimitTrackerOptions = {},
) {
  const now = options.now || Date.now;
  const random = options.random || Math.random;
  const baseDelayMs = boundedInteger(options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS, MIN_DELAY_MS, DEFAULT_MAX_DELAY_MS);
  const maxDelayMs = boundedInteger(options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS, MIN_DELAY_MS, 10 * 60_000);
  const maxBackoffAttempts = boundedInteger(options.maxBackoffAttempts ?? DEFAULT_MAX_BACKOFF_ATTEMPTS, 1, 16);
  let firstObservedAtMs: number | null = null;
  let observedCount = 0;

  const observe = (retryAfterHeader?: string | null): ZrokRateLimitInfo => {
    const observedAtMs = now();
    firstObservedAtMs ??= observedAtMs;
    observedCount = Math.min(MAX_OBSERVED_COUNT, observedCount + 1);

    const retryAfterMs = parseZrokRetryAfterMs(retryAfterHeader, observedAtMs, maxDelayMs);
    const exponent = Math.min(maxBackoffAttempts - 1, Math.max(0, observedCount - 1));
    const fallbackBase = Math.min(maxDelayMs, baseDelayMs * (2 ** exponent));
    const jitter = Math.floor(fallbackBase * 0.25 * Math.max(0, Math.min(1, random())));
    const delayMs = retryAfterMs ?? Math.min(maxDelayMs, fallbackBase + jitter);

    return {
      source,
      firstObservedAt: new Date(firstObservedAtMs).toISOString(),
      lastObservedAt: new Date(observedAtMs).toISOString(),
      nextAttemptAt: new Date(observedAtMs + delayMs).toISOString(),
      retryAfterMs: delayMs,
      observedCount,
    };
  };

  const reset = () => {
    firstObservedAtMs = null;
    observedCount = 0;
  };

  return { observe, reset };
}

export class ZrokRateLimitError extends Error {
  constructor(
    readonly rateLimit: ZrokRateLimitInfo,
    readonly mutationOutcomeUnknown = false,
  ) {
    super('ZROK_RATE_LIMITED');
    this.name = 'ZrokRateLimitError';
  }
}

export function zrokRateLimitFromError(error: unknown): ZrokRateLimitInfo | undefined {
  if (error instanceof ZrokRateLimitError) return error.rateLimit;
  if (!error || typeof error !== 'object') return undefined;
  const candidate = (error as { rateLimit?: unknown }).rateLimit;
  if (!candidate || typeof candidate !== 'object') return undefined;
  const value = candidate as Partial<ZrokRateLimitInfo>;
  if (
    (value.source !== 'public' && value.source !== 'control' && value.source !== 'local-agent')
    || typeof value.firstObservedAt !== 'string'
    || typeof value.lastObservedAt !== 'string'
    || typeof value.nextAttemptAt !== 'string'
    || typeof value.retryAfterMs !== 'number'
    || typeof value.observedCount !== 'number'
  ) return undefined;
  return value as ZrokRateLimitInfo;
}

export function zrokMutationOutcomeUnknown(error: unknown) {
  return error instanceof ZrokRateLimitError
    ? error.mutationOutcomeUnknown
    : Boolean(error && typeof error === 'object' && (error as { mutationOutcomeUnknown?: unknown }).mutationOutcomeUnknown === true);
}
