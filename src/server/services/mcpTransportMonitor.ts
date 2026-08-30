import type {
  McpStreamableHttpLifecycleHooks,
  McpStreamableHttpLifecycleTiming,
  McpStreamableHttpSessionLifecycleEvent,
  McpStreamableHttpSessionLifecycleKind,
} from '../mcpStreamableHttp';

const MAX_RECORDS = 500;
const MAX_TRACE_RECORDS = 500;
const DEFAULT_TRACE_QUERY_LIMIT = 50;
const MAX_TRACE_QUERY_LIMIT = 100;
const MAX_SAFE_TOKEN_LENGTH = 160;
const DEFAULT_WINDOW_MS = 10 * 60 * 1000;
export const DEFAULT_RESTART_QUIESCENCE_WINDOW_MS = 5_000;
const MAX_RESTART_QUIESCENCE_WINDOW_MS = 60_000;
let nextTrackerId = 0;
let nextTraceSequence = 0;
let droppedTraceRecords = 0;
const activeRestartMeaningfulTrackers = new Set<number>();

export type McpTransportOperation = 'initialize' | 'tools/list' | 'tools/call' | 'other';
export type McpTransportPhase = 'parse' | 'connect' | 'handle' | 'close' | 'responseFinalize';
export type McpTransportTraceEventType = 'request' | 'session-lifecycle' | 'legacy-sse';
export type McpTransportTraceOutcome = 'success' | 'error' | 'aborted' | 'unknown';
export type McpTransportTraceLifecycleEvent = McpStreamableHttpSessionLifecycleKind
  | 'sse-connect'
  | 'sse-disconnect'
  | 'sse-error'
  | 'sse-post-miss';

type McpTransportPhaseMs = Record<McpTransportPhase, number>;

export interface McpTransportRequestInput {
  operation: McpTransportOperation;
  statusCode: number;
  totalMs: number;
  phaseMs: McpTransportPhaseMs;
  timestamp?: number;
  correlationId?: string | null;
  toolName?: string | null;
  runtimeInstanceId?: string | null;
  outcome?: McpTransportTraceOutcome;
}

type McpTransportRecord = McpTransportRequestInput & { timestamp: number };

export interface McpTransportTraceEventInput {
  eventType: Exclude<McpTransportTraceEventType, 'request'>;
  lifecycleEvent: McpTransportTraceLifecycleEvent;
  correlationId?: string | null;
  runtimeInstanceId?: string | null;
  operation?: McpTransportOperation | null;
  toolName?: string | null;
  statusCode?: number | null;
  outcome?: McpTransportTraceOutcome;
  totalMs?: number | null;
  timestamp?: number;
}

export interface McpTransportTraceRecord {
  sequence: number;
  eventType: McpTransportTraceEventType;
  lifecycleEvent: McpTransportTraceLifecycleEvent | null;
  correlationId: string | null;
  runtimeInstanceId: string | null;
  operation: McpTransportOperation | null;
  toolName: string | null;
  statusCode: number | null;
  outcome: McpTransportTraceOutcome;
  totalMs: number | null;
  phaseMs: McpTransportPhaseMs | null;
  timestamp: number;
}

export interface McpTransportTraceQuery {
  limit?: number;
  since?: number;
  errorsOnly?: boolean;
  slowMinMs?: number;
  correlationId?: string;
  operation?: McpTransportOperation;
  toolName?: string;
  runtimeInstanceId?: string;
  eventType?: McpTransportTraceEventType;
  lifecycleEvent?: McpTransportTraceLifecycleEvent;
}

const records: McpTransportRecord[] = [];
const traceRecords: McpTransportTraceRecord[] = [];

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

const TRACE_EVENT_TYPES = new Set<McpTransportTraceEventType>(['request', 'session-lifecycle', 'legacy-sse']);
const TRACE_OUTCOMES = new Set<McpTransportTraceOutcome>(['success', 'error', 'aborted', 'unknown']);
const TRACE_LIFECYCLE_EVENTS = new Set<McpTransportTraceLifecycleEvent>([
  'request-start',
  'request-end',
  'created',
  'ttl-expired',
  'error-closed',
  'capacity-evicted',
  'stale-session-404',
  'sse-connect',
  'sse-disconnect',
  'sse-error',
  'sse-post-miss',
]);

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

function nonNegative(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function nullableNonNegative(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : null;
}

function normalizeTimestamp(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Date.now();
}

function normalizeStatusCode(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(999, Math.floor(number))) : null;
}

function normalizeSafeToken(value: unknown, maxLength = MAX_SAFE_TOKEN_LENGTH) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(trimmed) ? trimmed : null;
}

function normalizeOutcome(value: unknown): McpTransportTraceOutcome {
  return typeof value === 'string' && TRACE_OUTCOMES.has(value as McpTransportTraceOutcome)
    ? value as McpTransportTraceOutcome
    : 'unknown';
}
function normalizeOperation(value: unknown): McpTransportOperation | null {
  return value === 'initialize' || value === 'tools/list' || value === 'tools/call' || value === 'other'
    ? value
    : null;
}

function pushTraceRecord(input: Omit<McpTransportTraceRecord, 'sequence'>) {
  const record: McpTransportTraceRecord = { sequence: ++nextTraceSequence, ...input };
  traceRecords.push(record);
  if (traceRecords.length > MAX_TRACE_RECORDS) {
    const overflow = traceRecords.length - MAX_TRACE_RECORDS;
    traceRecords.splice(0, overflow);
    droppedTraceRecords = Math.min(Number.MAX_SAFE_INTEGER, droppedTraceRecords + overflow);
  }
  return record;
}

function recordRequestTrace(record: McpTransportRecord) {
  pushTraceRecord({
    eventType: 'request',
    lifecycleEvent: null,
    correlationId: normalizeSafeToken(record.correlationId),
    runtimeInstanceId: normalizeSafeToken(record.runtimeInstanceId),
    operation: record.operation,
    toolName: normalizeSafeToken(record.toolName),
    statusCode: normalizeStatusCode(record.statusCode),
    outcome: normalizeOutcome(record.outcome),
    totalMs: nonNegative(record.totalMs),
    phaseMs: {
      parse: nonNegative(record.phaseMs.parse),
      connect: nonNegative(record.phaseMs.connect),
      handle: nonNegative(record.phaseMs.handle),
      close: nonNegative(record.phaseMs.close),
      responseFinalize: nonNegative(record.phaseMs.responseFinalize),
    },
    timestamp: normalizeTimestamp(record.timestamp),
  });
}

export function recordMcpTransportTraceEvent(input: McpTransportTraceEventInput) {
  const eventType = TRACE_EVENT_TYPES.has(input.eventType)
    ? input.eventType
    : 'session-lifecycle';
  const lifecycleEvent = TRACE_LIFECYCLE_EVENTS.has(input.lifecycleEvent) ? input.lifecycleEvent : null;
  return pushTraceRecord({
    eventType,
    lifecycleEvent,
    correlationId: normalizeSafeToken(input.correlationId),
    runtimeInstanceId: normalizeSafeToken(input.runtimeInstanceId),
    operation: normalizeOperation(input.operation),
    toolName: normalizeSafeToken(input.toolName),
    statusCode: normalizeStatusCode(input.statusCode),
    outcome: normalizeOutcome(input.outcome),
    totalMs: nullableNonNegative(input.totalMs),
    phaseMs: null,
    timestamp: normalizeTimestamp(input.timestamp),
  });
}

export function recordMcpStreamableHttpSessionLifecycle(event: McpStreamableHttpSessionLifecycleEvent) {
  sessionLifecycleDiagnostics.activeSessions = Math.max(0, Math.floor(nonNegative(event.activeSessions)));
  sessionLifecycleDiagnostics.idleSessions = Math.max(0, Math.floor(nonNegative(event.idleSessions)));
  const timestamp = normalizeTimestamp(event.timestamp);
  sessionLifecycleDiagnostics.lastLifecycleEventAt = timestamp;
  if (event.kind === 'request-start') sessionLifecycleDiagnostics.lastMcpRequestAt = timestamp;
  if (event.kind === 'created') sessionLifecycleDiagnostics.created += 1;
  if (event.kind === 'ttl-expired') sessionLifecycleDiagnostics.ttlExpired += 1;
  if (event.kind === 'error-closed') sessionLifecycleDiagnostics.errorClosed += 1;
  if (event.kind === 'capacity-evicted') sessionLifecycleDiagnostics.capacityEvicted += 1;
  if (event.kind === 'stale-session-404') sessionLifecycleDiagnostics.staleSession404 += 1;
  const metadata = event as McpStreamableHttpSessionLifecycleEvent & {
    correlationId?: string | null;
    runtimeInstanceId?: string | null;
    outcome?: McpTransportTraceOutcome;
    statusCode?: number | null;
    totalMs?: number | null;
  };
  recordMcpTransportTraceEvent({
    eventType: 'session-lifecycle',
    lifecycleEvent: event.kind,
    correlationId: metadata.correlationId,
    runtimeInstanceId: metadata.runtimeInstanceId,
    statusCode: metadata.statusCode,
    outcome: metadata.outcome,
    totalMs: metadata.totalMs,
    timestamp,
  });
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
  traceRecords.length = 0;
  droppedTraceRecords = 0;
  nextTraceSequence = 0;
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
    if (/^(?:restart_devflow|.*(?:[.:/]|__)restart_devflow)$/.test(toolName.trim())) return 'other';
    return 'tools/call';
  }
  return 'other';
}

export function getMcpTransportToolName(body: unknown) {
  const method = typeof (body as any)?.method === 'string' ? String((body as any).method) : '';
  if (method !== 'tools/call') return null;
  return normalizeSafeToken((body as any)?.params?.name);
}

const RESTART_CONTROL_TOOL_NAMES = new Set([
  'devflow_health_check',
  'get_devflow_restart_status',
]);

function canonicalToolName(toolName: string | null | undefined) {
  const normalized = normalizeSafeToken(toolName);
  if (!normalized) return null;
  const segments = normalized.split(/(?:[.:/]|__)+/).filter(Boolean);
  return segments.at(-1) || normalized;
}

function isRestartControlRecord(record: McpTransportRecord) {
  if (record.operation === 'initialize' || record.operation === 'tools/list') return true;
  if (record.operation !== 'tools/call') return false;
  const toolName = canonicalToolName(record.toolName);
  return Boolean(toolName && RESTART_CONTROL_TOOL_NAMES.has(toolName));
}

function isRestartMeaningfulOperation(operation: McpTransportOperation) {
  return operation === 'initialize' || operation === 'tools/list' || operation === 'tools/call';
}

export function recordMcpTransportRequest(input: McpTransportRequestInput) {
  const record: McpTransportRecord = {
    operation: normalizeOperation(input.operation) || 'other',
    statusCode: Number.isFinite(Number(input.statusCode)) ? Number(input.statusCode) : 0,
    totalMs: nonNegative(input.totalMs),
    phaseMs: {
      parse: nonNegative(input.phaseMs?.parse),
      connect: nonNegative(input.phaseMs?.connect),
      handle: nonNegative(input.phaseMs?.handle),
      close: nonNegative(input.phaseMs?.close),
      responseFinalize: nonNegative(input.phaseMs?.responseFinalize),
    },
    timestamp: normalizeTimestamp(input.timestamp),
    correlationId: normalizeSafeToken(input.correlationId),
    toolName: normalizeSafeToken(input.toolName),
    runtimeInstanceId: normalizeSafeToken(input.runtimeInstanceId),
    outcome: normalizeOutcome(input.outcome),
  };
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  recordRequestTrace(record);
  return record;
}

export function queryMcpTransportTrace(options: McpTransportTraceQuery = {}) {
  const requestedLimit = Number(options.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(MAX_TRACE_QUERY_LIMIT, Math.floor(requestedLimit)))
    : DEFAULT_TRACE_QUERY_LIMIT;
  const invalidFilters: string[] = [];
  const normalizedCorrelationId = options.correlationId === undefined ? undefined : normalizeSafeToken(options.correlationId);
  const normalizedToolName = options.toolName === undefined ? undefined : normalizeSafeToken(options.toolName);
  const normalizedRuntimeInstanceId = options.runtimeInstanceId === undefined ? undefined : normalizeSafeToken(options.runtimeInstanceId);
  if (options.correlationId !== undefined && !normalizedCorrelationId) invalidFilters.push('correlationId');
  if (options.toolName !== undefined && !normalizedToolName) invalidFilters.push('toolName');
  if (options.runtimeInstanceId !== undefined && !normalizedRuntimeInstanceId) invalidFilters.push('runtimeInstanceId');
  if (options.operation !== undefined && !['initialize', 'tools/list', 'tools/call', 'other'].includes(options.operation)) invalidFilters.push('operation');
  if (options.eventType !== undefined && !TRACE_EVENT_TYPES.has(options.eventType)) invalidFilters.push('eventType');
  if (options.lifecycleEvent !== undefined && !TRACE_LIFECYCLE_EVENTS.has(options.lifecycleEvent)) invalidFilters.push('lifecycleEvent');
  if (options.since !== undefined && (!Number.isFinite(Number(options.since)) || Number(options.since) < 0)) invalidFilters.push('since');
  if (options.slowMinMs !== undefined && (!Number.isFinite(Number(options.slowMinMs)) || Number(options.slowMinMs) < 0)) invalidFilters.push('slowMinMs');
  const since = nullableNonNegative(options.since);
  const slowMinMs = nullableNonNegative(options.slowMinMs);
  if (invalidFilters.length > 0) {
    return {
      records: [] as McpTransportTraceRecord[],
      returned: 0,
      totalMatched: 0,
      retainedRecords: traceRecords.length,
      droppedRecords: droppedTraceRecords,
      truncated: false,
      limit,
      invalidFilters,
      privacy: tracePrivacy(),
    };
  }

  const matching = traceRecords.filter((record) => {
    if (since !== null && record.timestamp < since) return false;
    if (options.errorsOnly === true && !(record.outcome === 'error' || (record.statusCode || 0) >= 400)) return false;
    if (slowMinMs !== null && (record.totalMs === null || record.totalMs < slowMinMs)) return false;
    if (normalizedCorrelationId !== undefined && record.correlationId !== normalizedCorrelationId) return false;
    if (options.operation !== undefined && record.operation !== options.operation) return false;
    if (normalizedToolName !== undefined && record.toolName !== normalizedToolName) return false;
    if (normalizedRuntimeInstanceId !== undefined && record.runtimeInstanceId !== normalizedRuntimeInstanceId) return false;
    if (options.eventType !== undefined && record.eventType !== options.eventType) return false;
    if (options.lifecycleEvent !== undefined && record.lifecycleEvent !== options.lifecycleEvent) return false;
    return true;
  });
  const selected = matching.slice(-limit).reverse().map((record) => ({ ...record }));
  return {
    records: selected,
    returned: selected.length,
    totalMatched: matching.length,
    retainedRecords: traceRecords.length,
    droppedRecords: droppedTraceRecords,
    truncated: matching.length > selected.length,
    limit,
    invalidFilters,
    privacy: tracePrivacy(),
  };
}

function tracePrivacy() {
  return {
    rawPayloadsStored: false,
    rawHeadersStored: false,
    toolArgumentsStored: false,
    rawSessionIdentifiersStored: false,
    rawClientIdentifiersStored: false,
  };
}

const DEFAULT_CUTOFF_EVIDENCE_WINDOW_MS = 10 * 60 * 1000;
const MAX_CUTOFF_EVIDENCE_WINDOW_MS = 60 * 60 * 1000;
const MAX_CUTOFF_EVIDENCE_EVENTS = 8;

export type McpTransportCutoffClassification = 'transport-abort' | 'idle-expiry' | 'unknown';

function isTransportAbortSignal(record: McpTransportTraceRecord) {
  return record.outcome === 'aborted'
    || record.lifecycleEvent === 'error-closed'
    || record.lifecycleEvent === 'sse-error'
    || record.lifecycleEvent === 'sse-disconnect';
}

export function getMcpTransportCutoffEvidence(options: {
  now?: number;
  windowMs?: number;
  runtimeInstanceIds?: string[];
} = {}) {
  const now = options.now ?? Date.now();
  const requestedWindowMs = Number(options.windowMs);
  const windowMs = Number.isFinite(requestedWindowMs)
    ? Math.max(1, Math.min(MAX_CUTOFF_EVIDENCE_WINDOW_MS, Math.floor(requestedWindowMs)))
    : DEFAULT_CUTOFF_EVIDENCE_WINDOW_MS;
  const runtimeInstanceIds = new Set((options.runtimeInstanceIds || [])
    .map((value) => normalizeSafeToken(value))
    .filter((value): value is string => Boolean(value)));
  const recent = traceRecords.filter((record) => (
    record.timestamp >= now - windowMs
    && record.timestamp <= now
    && (runtimeInstanceIds.size === 0 || Boolean(record.runtimeInstanceId && runtimeInstanceIds.has(record.runtimeInstanceId)))
  ));
  const signals = recent.filter((record) => record.lifecycleEvent === 'ttl-expired' || isTransportAbortSignal(record));
  const latestSignal = signals.at(-1) || null;
  const classification: McpTransportCutoffClassification = latestSignal?.lifecycleEvent === 'ttl-expired'
    ? 'idle-expiry'
    : latestSignal && isTransportAbortSignal(latestSignal)
      ? 'transport-abort'
      : 'unknown';
  const reasonCodes = latestSignal?.lifecycleEvent === 'ttl-expired'
    ? ['MCP_SESSION_IDLE_TTL_EXPIRED']
    : latestSignal?.outcome === 'aborted'
      ? ['MCP_REQUEST_ABORTED']
      : latestSignal?.lifecycleEvent === 'error-closed'
        ? ['MCP_SESSION_ERROR_CLOSED']
        : latestSignal?.lifecycleEvent === 'sse-error'
          ? ['MCP_SSE_ERROR']
          : latestSignal?.lifecycleEvent === 'sse-disconnect'
            ? ['MCP_SSE_DISCONNECTED']
            : ['MCP_CUTOFF_EVIDENCE_INSUFFICIENT'];
  const selected = signals.slice(-MAX_CUTOFF_EVIDENCE_EVENTS).reverse().map((record) => ({
    sequence: record.sequence,
    eventType: record.eventType,
    lifecycleEvent: record.lifecycleEvent,
    correlationId: record.correlationId,
    runtimeInstanceId: record.runtimeInstanceId,
    operation: record.operation,
    toolName: record.toolName,
    statusCode: record.statusCode,
    outcome: record.outcome,
    totalMs: record.totalMs,
    timestamp: record.timestamp,
  }));

  return {
    classification,
    reasonCodes,
    observedAt: latestSignal ? new Date(latestSignal.timestamp).toISOString() : null,
    windowMs,
    evidenceEvents: selected,
    evidenceEventCount: signals.length,
    truncated: signals.length > selected.length,
    retainedRecords: traceRecords.length,
    droppedRecords: droppedTraceRecords,
    privacy: tracePrivacy(),
  };
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
  const restartControlRecords = recentMeaningful.filter(isRestartControlRecord);
  const recentWorkload = recentMeaningful.filter((record) => !isRestartControlRecord(record));
  const recentInitializeOperations = recentMeaningful.filter((record) => record.operation === 'initialize').length;
  const recentToolsListOperations = recentMeaningful.filter((record) => record.operation === 'tools/list').length;
  const recentToolCalls = recentMeaningful.filter((record) => record.operation === 'tools/call').length;
  const recentRestartControlOperations = restartControlRecords.length;
  const recentWorkloadToolCalls = recentWorkload.filter((record) => record.operation === 'tools/call').length;
  const recentQuiescenceBusy = recentWorkload.length > 0;
  const lastMeaningfulTimestamp = recentMeaningful.reduce((latest, record) => Math.max(latest, record.timestamp), 0);
  const lastWorkloadTimestamp = recentWorkload.reduce((latest, record) => Math.max(latest, record.timestamp), 0);
  const inFlightMeaningfulOperations = activeRestartMeaningfulTrackers.size;

  return {
    busy: inFlightMeaningfulOperations > 0 || recentQuiescenceBusy,
    quiescenceWindowMs,
    inFlightMeaningfulOperations,
    recentMeaningfulOperations: recentMeaningful.length,
    recentInitializeOperations,
    recentToolsListOperations,
    recentToolCalls,
    recentRestartControlOperations,
    recentWorkloadOperations: recentWorkload.length,
    recentWorkloadToolCalls,
    recentQuiescenceBusy,
    lastMeaningfulActivityAt: lastMeaningfulTimestamp > 0 ? new Date(lastMeaningfulTimestamp).toISOString() : null,
    lastWorkloadActivityAt: lastWorkloadTimestamp > 0 ? new Date(lastWorkloadTimestamp).toISOString() : null,
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
    trace: {
      retainedRecords: traceRecords.length,
      droppedRecords: droppedTraceRecords,
      maxRecords: MAX_TRACE_RECORDS,
    },
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
      ...tracePrivacy(),
      aggregateNumericTimingsOnly: true,
      traceMetadataOnly: true,
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
  correlationId?: string | null;
  toolName?: string | null;
  runtimeInstanceId?: string | null;
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
    complete(params?: { statusCode?: number; responseFinishedAt?: number; outcome?: McpTransportTraceOutcome }) {
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
        correlationId: input.correlationId,
        toolName: input.toolName,
        runtimeInstanceId: input.runtimeInstanceId,
        outcome: params?.outcome,
      });
    },
  };
}
