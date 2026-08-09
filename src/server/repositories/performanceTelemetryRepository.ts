import db from '../../db/index.js';

const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_ROWS = 5_000;
const DEFAULT_MIN_SAMPLES = 5;
const DEFAULT_MAX_BASELINE_SNAPSHOTS = 50;

export interface PerformanceTelemetrySnapshot {
  windowStart: number;
  windowEnd: number;
  toolName: string;
  projectScope?: string;
  contractRevision: string;
  appRevision: string;
  count: number;
  errorCount: number;
  p50DurationMs: number;
  p95DurationMs: number;
  inputBytes: number;
  responseBytes: number;
  truncatedCount: number;
  truncationRate?: number;
  cacheHitCount: number;
  processSpawns: number;
}

type CompactionOptions = {
  now?: number;
  retentionMs?: number;
  maxRows?: number;
};

type BaselineQuery = {
  toolName: string;
  projectScope?: string;
  beforeWindowEnd?: number;
  minSamples?: number;
  maxSnapshots?: number;
  excludeAppRevision?: string;
};

function boundedPositiveInteger(value: unknown, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nonNegativeInteger(value: unknown) {
  return Math.max(0, Math.floor(finiteNumber(value)));
}

function normalizeSnapshot(snapshot: PerformanceTelemetrySnapshot): PerformanceTelemetrySnapshot {
  const count = nonNegativeInteger(snapshot.count);
  const truncatedCount = nonNegativeInteger(snapshot.truncatedCount);
  return {
    windowStart: nonNegativeInteger(snapshot.windowStart),
    windowEnd: nonNegativeInteger(snapshot.windowEnd),
    toolName: String(snapshot.toolName || '').trim(),
    projectScope: String(snapshot.projectScope || '').trim(),
    contractRevision: String(snapshot.contractRevision || '').trim() || 'unknown',
    appRevision: String(snapshot.appRevision || '').trim() || 'unknown',
    count,
    errorCount: nonNegativeInteger(snapshot.errorCount),
    p50DurationMs: Math.max(0, finiteNumber(snapshot.p50DurationMs)),
    p95DurationMs: Math.max(0, finiteNumber(snapshot.p95DurationMs)),
    inputBytes: nonNegativeInteger(snapshot.inputBytes),
    responseBytes: nonNegativeInteger(snapshot.responseBytes),
    truncatedCount,
    truncationRate: count > 0 ? Math.round((truncatedCount / count) * 10_000) / 10_000 : 0,
    cacheHitCount: nonNegativeInteger(snapshot.cacheHitCount),
    processSpawns: nonNegativeInteger(snapshot.processSpawns),
  };
}

export function compactPerformanceHistory(options: CompactionOptions = {}) {
  const now = nonNegativeInteger(options.now ?? Date.now());
  const retentionMs = boundedPositiveInteger(options.retentionMs, DEFAULT_RETENTION_MS);
  const maxRows = boundedPositiveInteger(options.maxRows, DEFAULT_MAX_ROWS);
  const cutoff = Math.max(0, now - retentionMs);

  const deletedByAge = db.prepare('DELETE FROM performance_telemetry_snapshots WHERE windowEnd < ?').run(cutoff).changes;
  const row = db.prepare('SELECT COUNT(*) AS count FROM performance_telemetry_snapshots').get() as { count: number };
  const overflow = Math.max(0, Number(row?.count || 0) - maxRows);
  let deletedByCap = 0;
  if (overflow > 0) {
    deletedByCap = db.prepare(`
      DELETE FROM performance_telemetry_snapshots
      WHERE id IN (
        SELECT id
        FROM performance_telemetry_snapshots
        ORDER BY windowEnd ASC, id ASC
        LIMIT ?
      )
    `).run(overflow).changes;
  }

  return { deletedByAge, deletedByCap, retainedRows: Math.max(0, Number(row?.count || 0) - deletedByCap) };
}

export function persistPerformanceSnapshots(snapshots: PerformanceTelemetrySnapshot[], options: CompactionOptions = {}) {
  const insert = db.prepare(`
    INSERT INTO performance_telemetry_snapshots (
      windowStart, windowEnd, toolName, projectScope, contractRevision, appRevision,
      count, errorCount, p50DurationMs, p95DurationMs, inputBytes, responseBytes,
      truncatedCount, truncationRate, cacheHitCount, processSpawns
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const writeBatch = db.transaction((items: PerformanceTelemetrySnapshot[]) => {
    let inserted = 0;
    for (const raw of items) {
      const snapshot = normalizeSnapshot(raw);
      if (!snapshot.toolName || snapshot.count <= 0) continue;
      insert.run(
        snapshot.windowStart,
        snapshot.windowEnd,
        snapshot.toolName,
        snapshot.projectScope || '',
        snapshot.contractRevision,
        snapshot.appRevision,
        snapshot.count,
        snapshot.errorCount,
        snapshot.p50DurationMs,
        snapshot.p95DurationMs,
        snapshot.inputBytes,
        snapshot.responseBytes,
        snapshot.truncatedCount,
        snapshot.truncationRate,
        snapshot.cacheHitCount,
        snapshot.processSpawns,
      );
      inserted += 1;
    }
    return inserted;
  });

  const inserted = writeBatch(Array.isArray(snapshots) ? snapshots : []);
  const compaction = compactPerformanceHistory(options);
  return { inserted, ...compaction };
}

export function getPerformanceBaseline(query: BaselineQuery) {
  const toolName = String(query.toolName || '').trim();
  const projectScope = String(query.projectScope || '').trim();
  const beforeWindowEnd = nonNegativeInteger(query.beforeWindowEnd ?? Date.now() + 1);
  const minSamples = boundedPositiveInteger(query.minSamples, DEFAULT_MIN_SAMPLES);
  const maxSnapshots = boundedPositiveInteger(query.maxSnapshots, DEFAULT_MAX_BASELINE_SNAPSHOTS);

  const params: Array<string | number> = [toolName, projectScope, beforeWindowEnd];
  const appRevisionFilter = query.excludeAppRevision
    ? 'AND appRevision <> ?'
    : '';
  if (query.excludeAppRevision) params.push(String(query.excludeAppRevision));
  params.push(maxSnapshots);

  const rows = db.prepare(`
    SELECT windowStart, windowEnd, toolName, projectScope, contractRevision, appRevision,
           count, errorCount, p50DurationMs, p95DurationMs, inputBytes, responseBytes,
           truncatedCount, truncationRate, cacheHitCount, processSpawns
    FROM performance_telemetry_snapshots
    WHERE toolName = ? AND projectScope = ? AND windowEnd < ?
      ${appRevisionFilter}
    ORDER BY windowEnd DESC, id DESC
    LIMIT ?
  `).all(...params) as PerformanceTelemetrySnapshot[];

  const sampleCount = rows.reduce((sum, row) => sum + nonNegativeInteger(row.count), 0);
  const snapshotCount = rows.length;
  if (sampleCount < minSamples) {
    return {
      status: 'insufficient-samples' as const,
      toolName,
      projectScope,
      sampleCount,
      snapshotCount,
      minSamples,
    };
  }

  const weighted = (key: 'p50DurationMs' | 'p95DurationMs') => Math.round(
    rows.reduce((sum, row) => sum + finiteNumber(row[key]) * nonNegativeInteger(row.count), 0) / sampleCount,
  );
  const sum = (key: 'errorCount' | 'inputBytes' | 'responseBytes' | 'truncatedCount' | 'cacheHitCount' | 'processSpawns') =>
    rows.reduce((total, row) => total + nonNegativeInteger(row[key]), 0);

  const truncatedCount = sum('truncatedCount');

  return {
    status: 'ready' as const,
    toolName,
    projectScope,
    sampleCount,
    snapshotCount,
    p50DurationMs: weighted('p50DurationMs'),
    p95DurationMs: weighted('p95DurationMs'),
    errorCount: sum('errorCount'),
    inputBytes: sum('inputBytes'),
    responseBytes: sum('responseBytes'),
    truncatedCount,
    truncationRate: Math.round((truncatedCount / sampleCount) * 10_000) / 10_000,
    cacheHitCount: sum('cacheHitCount'),
    processSpawns: sum('processSpawns'),
    windowStart: Math.min(...rows.map((row) => nonNegativeInteger(row.windowStart))),
    windowEnd: Math.max(...rows.map((row) => nonNegativeInteger(row.windowEnd))),
  };
}
