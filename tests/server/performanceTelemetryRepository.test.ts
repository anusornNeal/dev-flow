import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-performance-history-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { runMigrations } = await import('../../src/db/migrations/runner.js');
const { performanceTelemetryHistoryMigration } = await import('../../src/db/migrations/008-performance-telemetry-history.js');
const { default: db } = await import('../../src/db/index.js');

executeAllMigrations();

test('performance telemetry migration creates aggregate-only history schema', () => {
  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get('performance_telemetry_snapshots') as any;
  assert.equal(table?.name, 'performance_telemetry_snapshots');

  const columns = (db.pragma('table_info(performance_telemetry_snapshots)') as Array<{ name: string }>).map((column) => column.name);
  for (const expected of [
    'windowStart', 'windowEnd', 'toolName', 'projectScope', 'contractRevision', 'appRevision',
    'count', 'errorCount', 'p50DurationMs', 'p95DurationMs', 'inputBytes', 'responseBytes',
    'truncatedCount', 'truncationRate', 'cacheHitCount', 'processSpawns',
  ]) {
    assert.equal(columns.includes(expected), true, `missing aggregate column ${expected}`);
  }
  for (const forbidden of ['args', 'prompt', 'content', 'token', 'secret', 'inputHash', 'localPath']) {
    assert.equal(columns.includes(forbidden), false, `forbidden raw/sensitive column ${forbidden}`);
  }
});

test('performance telemetry migration upgrades an existing migration history', () => {
  db.prepare('DROP TABLE IF EXISTS performance_telemetry_snapshots').run();
  db.prepare('DELETE FROM migrations WHERE id = ?').run(performanceTelemetryHistoryMigration.id);
  const existing = db.prepare('SELECT COUNT(*) AS count FROM migrations').get() as { count: number };
  assert.equal(existing.count >= 7, true);

  runMigrations(db, [performanceTelemetryHistoryMigration]);

  const table = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get('performance_telemetry_snapshots') as any;
  const applied = db.prepare('SELECT id FROM migrations WHERE id = ?').get(performanceTelemetryHistoryMigration.id) as any;
  assert.equal(table?.name, 'performance_telemetry_snapshots');
  assert.equal(applied?.id, performanceTelemetryHistoryMigration.id);
});

async function loadRepository() {
  try {
    return await import('../../src/server/repositories/performanceTelemetryRepository.js');
  } catch {
    return null;
  }
}

function snapshot(overrides: Record<string, any> = {}) {
  return {
    windowStart: 1_000,
    windowEnd: 2_000,
    toolName: 'read_local_file',
    projectScope: 'project-test',
    contractRevision: 'contract-1',
    appRevision: 'app-1',
    count: 4,
    errorCount: 1,
    p50DurationMs: 10,
    p95DurationMs: 20,
    inputBytes: 100,
    responseBytes: 400,
    truncatedCount: 1,
    cacheHitCount: 2,
    processSpawns: 0,
    args: { secret: 'must-not-persist' },
    ...overrides,
  };
}

test('repository persists aggregate snapshots and returns weighted baseline', async () => {
  const repository = await loadRepository();
  assert.equal(typeof repository?.persistPerformanceSnapshots, 'function');
  assert.equal(typeof repository?.getPerformanceBaseline, 'function');
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();

  repository!.persistPerformanceSnapshots([
    snapshot(),
    snapshot({ windowStart: 2_001, windowEnd: 3_000, count: 6, errorCount: 0, p50DurationMs: 20, p95DurationMs: 30, inputBytes: 300, responseBytes: 600, cacheHitCount: 3 }),
  ], { now: 3_100, retentionMs: 100_000, maxRows: 100 });

  const rows = db.prepare('SELECT * FROM performance_telemetry_snapshots ORDER BY windowEnd').all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].truncationRate, 0.25);
  assert.doesNotMatch(JSON.stringify(rows), /must-not-persist|args|inputHash|localPath/);

  const baseline = repository!.getPerformanceBaseline({
    toolName: 'read_local_file',
    projectScope: 'project-test',
    beforeWindowEnd: 4_000,
    minSamples: 5,
    maxSnapshots: 10,
  });
  assert.equal(baseline.status, 'ready');
  assert.equal(baseline.sampleCount, 10);
  assert.equal(baseline.snapshotCount, 2);
  assert.equal(baseline.p50DurationMs, 16);
  assert.equal(baseline.p95DurationMs, 26);
  assert.equal(baseline.errorCount, 1);
  assert.equal(baseline.inputBytes, 400);
  assert.equal(baseline.responseBytes, 1_000);
  assert.equal(baseline.truncationRate, 0.2);
});

test('repository compaction deterministically enforces age and row caps', async () => {
  const repository = await loadRepository();
  assert.equal(typeof repository?.compactPerformanceHistory, 'function');
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();

  repository!.persistPerformanceSnapshots([
    snapshot({ windowStart: 500, windowEnd: 1_000 }),
    snapshot({ windowStart: 8_500, windowEnd: 9_000 }),
    snapshot({ windowStart: 8_600, windowEnd: 9_100 }),
    snapshot({ windowStart: 8_700, windowEnd: 9_200 }),
  ], { now: 9_500, retentionMs: 100_000, maxRows: 100 });

  const result = repository!.compactPerformanceHistory({ now: 9_500, retentionMs: 2_000, maxRows: 2 });
  const windows = (db.prepare('SELECT windowEnd FROM performance_telemetry_snapshots ORDER BY windowEnd DESC').all() as any[]).map((row) => row.windowEnd);
  assert.deepEqual(windows, [9_200, 9_100]);
  assert.equal(result.deletedByAge, 1);
  assert.equal(result.deletedByCap, 1);
});

test('persisted performance history is readable from a fresh process', async () => {
  const repository = await loadRepository();
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  repository!.persistPerformanceSnapshots([
    snapshot({ windowStart: 20_000, windowEnd: 21_000, count: 5, truncatedCount: 1 }),
  ], { now: 21_100, retentionMs: 100_000, maxRows: 100 });

  const script = [
    "const { executeAllMigrations } = await import('./src/db/migrations/index.js');",
    'executeAllMigrations();',
    "const { getPerformanceBaseline } = await import('./src/server/repositories/performanceTelemetryRepository.js');",
    "const result = getPerformanceBaseline({ toolName: 'read_local_file', projectScope: 'project-test', beforeWindowEnd: 22000, minSamples: 5 });",
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: process.cwd(),
    env: { ...process.env, DEVFLOW_DB_PATH: process.env.DEVFLOW_DB_PATH },
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const output = child.stdout.trim().split(/\r?\n/).pop() || '{}';
  const baseline = JSON.parse(output);
  assert.equal(baseline.status, 'ready');
  assert.equal(baseline.sampleCount, 5);
  assert.equal(baseline.truncationRate, 0.2);
});
