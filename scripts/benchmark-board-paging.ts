import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-board-benchmark-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../src/db/migrations/index.js');
executeAllMigrations();
const db = (await import('../src/db/index.js')).default;
const {
  archiveInactiveDoneTasks,
  getTasksByProjectId,
  queryTaskBoardPage,
} = await import('../src/server/repositories/taskRepository.js');

const projectId = 'project-board-benchmark';
db.prepare(`
  INSERT INTO projects (id, name, repoUrl, localPath, taskIdPrefix, createdAt)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(projectId, 'Board Benchmark', 'https://example.com/board-benchmark', tempDir, 'BENCH', '2026-08-08T00:00:00.000Z');

const insertTask = db.prepare(`
  INSERT INTO tasks (
    id, displayId, title, description, projectId, status, priority,
    tags, targetFiles, checklist, createdAt, updatedAt, logs, designImages, images
  ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', '[]', '[]', ?, ?, '[]', '[]', '[]')
`);

function seed(total: number) {
  db.prepare('DELETE FROM agent_runs').run();
  db.prepare('DELETE FROM tasks').run();
  const insertMany = db.transaction(() => {
    for (let index = 0; index < total; index += 1) {
      const active = index < 25;
      const suffix = String(index).padStart(5, '0');
      const updatedAt = active ? '2026-08-08T00:00:00.000Z' : '2020-01-01T00:00:00.000Z';
      insertTask.run(
        `bench-${total}-${suffix}`,
        `BENCH-${suffix}`,
        `Benchmark task ${suffix}`,
        'Board paging scaling fixture',
        projectId,
        'todo',
        'medium',
        updatedAt,
        updatedAt,
      );
    }
  });
  insertMany();
}

const results: Array<Record<string, number>> = [];
for (const totalTasks of [100, 500, 2000]) {
  seed(totalTasks);

  const legacyStart = performance.now();
  const legacyItems = getTasksByProjectId(projectId);
  const legacyMs = performance.now() - legacyStart;
  const legacyBytes = Buffer.byteLength(JSON.stringify(legacyItems), 'utf8');

  archiveInactiveDoneTasks({
    now: '2026-08-08T00:00:00.000Z',
    cutoff: '2026-05-10T00:00:00.000Z',
  });

  const pagedStart = performance.now();
  const page = queryTaskBoardPage({ projectId, status: 'todo', limit: 25, offset: 0 });
  const pagedMs = performance.now() - pagedStart;
  const pagedBytes = Buffer.byteLength(JSON.stringify({
    items: page.items,
    total: page.total,
    limit: page.limit,
    offset: page.offset,
    hasMore: page.hasMore,
  }), 'utf8');

  assert.equal(legacyItems.length, totalTasks);
  assert.equal(page.items.length, 25);
  assert.equal(page.hydratedTaskCount, 25);
  assert.equal(page.total, 25);

  results.push({
    totalTasks,
    legacyHydrated: legacyItems.length,
    legacyBytes,
    legacyMs: Number(legacyMs.toFixed(3)),
    pagedHydrated: page.hydratedTaskCount,
    pagedBytes,
    pagedMs: Number(pagedMs.toFixed(3)),
  });
}

console.log('BOARD_PAGING_BENCHMARK');
console.table(results);
console.log(JSON.stringify(results));
