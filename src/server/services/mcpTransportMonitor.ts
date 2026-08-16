import type {
  McpStreamableHttpLifecycleHooks,
  McpStreamableHttpLifecycleTiming,
  McpStreamableHttpSessionLifecycleEvent,
} from '../mcpStreamableHttp';

const MAX_RECORDS = 500;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_RESTART_QUIESCENCE_WINDOW_MS = 5_000;
const MAX_RESTART_QUIESCENCE_WINDOW_MS = 60_000;
let nextTrackerId = 0;
const activeRestartMeaningfulTrackers = new Set<number>();

export type McpTransportOperation = 'initialize' | 'tools/list' | 'tools/call' | 'other';
export type McpTransportPhase = 'parse' | 'connect' | 'handle' | 'close' | 'responseFinalize';

type McpTransportPhaseMs = Record<McpTransportPhase, number>;

export interface McpTransportRequestInput {
  operation: McpTransportOperation;
  statusCode: number;
  totalMs: number;
  phaseMs: McpTransportPhaseMs;
  timestamp?: number;
}

type McpTransportRecord = McpTransportRequestInput & { timestamp: number };

const records: McpTransportRecord[] = [];

const sessionLifecycleDiagnostics = {
  activeSessions: 0,
  idleSessions: 0,
  created: 0,
  ttlExpired: 0,
  errorClosed: 0,
  capacityEvicted: 0,
  staleSession404: 0,
  lastMcpRequestAt: 0,
  lastLifecycleEventAt: 0,
};

function resetSessionLifecycleDiagnostics() {
  sessionLifecycleDiagnostics.activeSessions = 0;
  sessionLifecycleDiagnostics.idleSessions = 0;
  sessionLifecycleDiagnostics.created = 0;
  sessionLifecycleDiagnostics.ttlExpired = 0;
  sessionLifecycleDiagnostics.errorClosed = 0;
  sessionLifecycleDiagnostics.capacityEvicted = 0;
  sessionLifecycleDiagnostics.staleSession404 = 0;
  sessionLifecycleDiagnostics.lastMcpRequestAt = 0;
  sessionLifecycleDiagnostics.lastLifecycleEventAt = 0;
}

export function recordMcpStreamableHttpSessionLifecycle(event: McpStreamableHttpSessionLifecycleEvent) {
  sessionLifecycleDiagnostics.activeSessions = Math.max(0, Math.floor(nonNegative(event.activeSessions)));
  sessionLifecycleDiagnostics.idleSessions = Math.max(0, Math.floor(nonNegative(event.idleSessions)));
  const timestamp = Number.isFinite(Number(event.timestamp)) ? Number(event.timestamp) : Date.now();
  sessionLifecycleDiagnostics.lastLifecycleEventAt = timestamp;
  if (event.kind === 'request-start') sessionLifecycleDiagnostics.lastMcpRequestAt = timestamp;
  if (event.kind === 'created') sessionLifecycleDiagnostics.created += 1;
  if (event.kind === 'ttl-expired') sessionLifecycleDiagnostics.ttlExpired += 1;
  if (event.kind === 'error-closed') sessionLifecycleDiagnostics.errorClosed += 1;
  if (event.kind === 'capacity-evicted') sessionLifecycleDiagnostics.capacityEvicted += 1;
  if (event.kind === 'stale-session-404') sessionLifecycleDiagnostics.staleSession404 += 1;
}

function nonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeSamples(values: number[]) {
  return {
    p50Ms: percentile(values, 50),
    p95Ms: percentile(values, 95),
  };
}

export function clearMcpTransportRecords() {
  records.length = 0;
  activeRestartMeaningfulTrackers.clear();
  nextTrackerId = 0;
  resetSessionLifecycleDiagnostics();
}

export function classifyMcpTransportOperation(body: unknown): McpTransportOperation {
  const method = typeof (body as any)?.method === 'string' ? String((body as any).method) : '';
  if (method === 'initialize') return 'initialize';
  if (method === 'tools/list') return 'tools/list';
  if (method === 'tools/call') {
    const toolName = typeof (body as any)?.params?.name === 'string' ? String((body as any).params.name) : '';
    if (toolName === 'restart_devflow') return 'other';
    return 'tools/call';
  }
  return 'other';
}

function isRestartMeaningfulOperation(operation: McpTransportOperation) {
  return operation === 'initialize' || operation === 'tools/list' || operation === 'tools/call';
}

export function recordMcpTransportRequest(input: McpTransportRequestInput) {
  const record: McpTransportRecord = {
    operation: input.operation,
    statusCode: Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : 0,
    totalMs: nonNegative(input.totalMs),
    phaseMs: {
      parse: nonNegative(input.phaseMs?.parse),
      connect: nonNegative(input.phaseMs?.connect),
      handle: nonNegative(input.phaseMs?.handle),
      close: nonNegative(input.phaseMs?.close),
      responseFinalize: nonNegative(input.phaseMs?.responseFinalize),
    },
    timestamp: input.timestamp ?? Date.now(),
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

export function getMcpRestartActivitySnapshot(options?: { now?: number; quiescenceWindowMs?: number }) {
  const now = options?.now ?? Date.now();
  const configuredWindowMs = Number(options?.quiescenceWindowMs);
  const quiescenceWindowMs = Number.isFinite(configuredWindowMs)
    ? Math.max(0, Math.min(MAX_RESTART_QUIESCENCE_WINDOW_MS, configuredWindowMs))
    : DEFAULT_RESTART_QUIESCENCE_WINDOW_MS;
  const cutoff = now - quiescenceWindowMs;
  const recentMeaningful = records.filter((record) => (
    isRestartMeaningfulOperation(record.operation)
    && record.timestamp >= cutoff
    && record.timestamp <= now
  ));
  const lastMeaningfulTimestamp = recentMeaningful.reduce(
    (latest, record) => Math.max(latest, record.timestamp),
    0,
  );
  const inFlightMeaningfulOperations = activeRestartMeaningfulTrackers.size;

  return {
    busy: inFlightMeaningfulOperations > 0 || recentMeaningful.length > 0,
    quiescenceWindowMs,
    inFlightMeaningfulOperations,
    recentMeaningfulOperations: recentMeaningful.length,
    lastMeaningfulActivityAt: lastMeaningfulTimestamp > 0 ? new Date(lastMeaningfulTimestamp).toISOString() : null,
    privacy: {
      rawSessionIdentifiersStored: false,
      rawClientIdentifiersStored: false,
    },
  };
}

export function getMcpTransportSummary(options?: { now?: number; windowMs?: number }) {
  const now = options?.now ?? Date.now();
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const recent = records.filter((record) => record.timestamp >= now - windowMs);
  const operationOrder: McpTransportOperation[] = ['initialize', 'tools/list', 'tools/call', 'other'];
  const byOperation = operationOrder.flatMap((operation) => {
    const matching = recent.filter((record) => record.operation === operation);
    if (matching.length === 0) return [];
    const phase = (name: McpTransportPhase) => summarizeSamples(matching.map((record) => record.phaseMs[name]));
    const totalSamples = matching.map((record) => record.totalMs);
    return [{
      operation,
      count: matching.length,
      errorCount: matching.filter((record) => record.statusCode >= 400).length,
      p50TotalMs: percentile(totalSamples, 50),
      p95TotalMs: percentile(totalSamples, 95),
      phases: {
        parse: phase('parse'),
        connect: phase('connect'),
        handle: phase('handle'),
        close: phase('close'),
        responseFinalize: phase('responseFinalize'),
      },
    }];
  });

  return {
    windowMs,
    totalRequests: recent.length,
    retainedRecords: records.length,
    byOperation,
    sessions: {
      activeSessions: sessionLifecycleDiagnostics.activeSessions,
      idleSessions: sessionLifecycleDiagnostics.idleSessions,
      created: sessionLifecycleDiagnostics.created,
      ttlExpired: sessionLifecycleDiagnostics.ttlExpired,
      errorClosed: sessionLifecycleDiagnostics.errorClosed,
      capacityEvicted: sessionLifecycleDiagnostics.capacityEvicted,
      staleSession404: sessionLifecycleDiagnostics.staleSession404,
      lastMcpRequestAt: sessionLifecycleDiagnostics.lastMcpRequestAt > 0
        ? new Date(sessionLifecycleDiagnostics.lastMcpRequestAt).toISOString()
        : null,
      lastLifecycleEventAt: sessionLifecycleDiagnostics.lastLifecycleEventAt > 0
        ? new Date(sessionLifecycleDiagnostics.lastLifecycleEventAt).toISOString()
        : null,
    },
    privacy: {
      rawPayloadsStored: false,
      aggregateNumericTimingsOnly: true,
      rawSessionIdentifiersStored: false,
      rawClientIdentifiersStored: false,
    },
    downstreamToolTelemetry: {
      source: 'tools',
      doubleCounted: false,
      note: 'Tool execution remains measured by the existing MCP tool monitor; transport handle timing is kept separate.',
    },
  };
}

export function createMcpTransportRequestTracker(input: {
  operation: McpTransportOperation;
  startedAt?: number;
  parseMs?: number;
  now?: () => number;
}) {
  const now = input.now || Date.now;
  const startedAt = input.startedAt ?? now();
  const phaseMs: McpTransportPhaseMs = {
    parse: nonNegative(input.parseMs),
    connect: 0,
    handle: 0,
    close: 0,
    responseFinalize: 0,
  };
  let completed = false;
  const trackerId = isRestartMeaningfulOperation(input.operation) ? ++nextTrackerId : null;
  if (trackerId !== null) activeRestartMeaningfulTrackers.add(trackerId);

  const onTiming = (event: McpStreamableHttpLifecycleTiming) => {
    if (event.phase === 'connect' || event.phase === 'handle' || event.phase === 'close') {
      phaseMs[event.phase] = nonNegative(event.durationMs);
    }
  };

  const hooks: McpStreamableHttpLifecycleHooks = { onTiming };

  return {
    hooks,
    complete(params?: { statusCode?: number; responseFinishedAt?: number }) {
      if (completed) return;
      completed = true;
      if (trackerId !== null) activeRestartMeaningfulTrackers.delete(trackerId);
      const responseFinishedAt = params?.responseFinishedAt ?? now();
      const totalMs = Math.max(0, responseFinishedAt - startedAt);
      phaseMs.responseFinalize = Math.max(0, totalMs - phaseMs.parse - phaseMs.connect - phaseMs.handle);
      recordMcpTransportRequest({
        operation: input.operation,
        statusCode: params?.statusCode ?? 0,
        totalMs,
        phaseMs,
        timestamp: responseFinishedAt,
      });
    },
  };
}
