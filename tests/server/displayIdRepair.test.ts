import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-display-id-repair-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const db = (await import('../../src/db/index.js')).default;
const { runMigrations } = await import('../../src/db/migrations/runner.js');
const { initMigration } = await import('../../src/db/migrations/001-init.js');
const { persistenceHardeningMigration } = await import('../../src/db/migrations/002-persistence-hardening.js');
const { taskBugThreadsMigration } = await import('../../src/db/migrations/003-task-bug-threads.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { generateDisplayId, resolveDisplayIdForNewTask } = await import('../../src/server/repositories/taskRepository.js');

function resetDatabase() {
  db.prepare(`DELETE FROM migrations WHERE id = '004-display-id-counter-repair'`).run();
  db.prepare('DELETE FROM attachments').run();
  db.prepare('DELETE FROM agent_runs').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM counters').run();
  db.prepare('DELETE FROM projects').run();
  db.prepare('DELETE FROM settings').run();
  db.prepare('DELETE FROM skills').run();
}

function insertTask(id: string, displayId: string, createdAt: string) {
  db.prepare(`
    INSERT INTO tasks (
      id, displayId, title, description, projectId, status, priority, branch, category, tags,
      targetFiles, checklist, effort, model, agent, parentId, reasoning, acceptanceCriteria,
      verification, repoContext, jiraKey, repo, createdAt, updatedAt, logs, designImages, images, bugs
    ) VALUES (?, ?, ?, '', ?, 'backlog', 'medium', NULL, 'backend', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)
  `).run(id, displayId, `Task ${displayId}`, 'project-dvf', createdAt, createdAt);
}

test.beforeEach(() => {
  resetDatabase();
  createProject({
    id: 'project-dvf',
    name: 'Dev Flow',
    taskIdPrefix: 'DVF',
    createdAt: '2026-07-02T00:00:00.000Z',
  });
});

runMigrations(db, [initMigration, persistenceHardeningMigration, taskBugThreadsMigration]);

test('repair migration renumbers polluted DVF ids and resets the DVF counter', async () => {
  insertTask('task-283', 'DVF-0283', '2026-07-02T00:00:00.000Z');
  insertTask('task-bad-1', 'DVF-1782968049898', '2026-07-02T00:01:00.000Z');
  insertTask('task-bad-2', 'DVF-1782968049899', '2026-07-02T00:02:00.000Z');
  insertTask('task-bad-3', 'DVF-1782968049900', '2026-07-02T00:03:00.000Z');
  db.prepare(`INSERT INTO counters (prefix, count) VALUES ('DVF', 1782968049900)`).run();

  const { displayIdCounterRepairMigration } = await import('../../src/db/migrations/004-display-id-counter-repair.js');
  runMigrations(db, [displayIdCounterRepairMigration]);

  const repairedRows = db.prepare(`
    SELECT id, displayId
    FROM tasks
    WHERE id IN ('task-283', 'task-bad-1', 'task-bad-2', 'task-bad-3')
    ORDER BY createdAt
  `).all() as Array<{ id: string; displayId: string }>;

  assert.deepEqual(repairedRows, [
    { id: 'task-283', displayId: 'DVF-0283' },
    { id: 'task-bad-1', displayId: 'DVF-0284' },
    { id: 'task-bad-2', displayId: 'DVF-0285' },
    { id: 'task-bad-3', displayId: 'DVF-0286' },
  ]);

  const counter = db.prepare(`SELECT count FROM counters WHERE prefix = 'DVF'`).get() as { count: number };
  assert.equal(counter.count, 286);
});

test('generateDisplayId ignores polluted cached counters and malformed DVF suffixes', () => {
  insertTask('task-282', 'DVF-0282', '2026-07-02T00:00:00.000Z');
  insertTask('task-283', 'DVF-0283', '2026-07-02T00:01:00.000Z');
  insertTask('task-bad-1', 'DVF-1782968049898', '2026-07-02T00:02:00.000Z');
  insertTask('task-bad-2', 'DVF-ABC', '2026-07-02T00:03:00.000Z');

  const state = { countersCache: { DVF: 1782968049898 } } as any;
  const nextId = generateDisplayId(state, 'project-dvf');

  assert.equal(nextId, 'DVF-0284');
  assert.equal(state.countersCache.DVF, 284);
});

test('new task display id resolution regenerates polluted supplied DVF ids', () => {
  insertTask('task-300', 'DVF-0300', '2026-07-02T00:00:00.000Z');

  const state = { countersCache: { DVF: 300 } } as any;
  const nextId = resolveDisplayIdForNewTask(state, 'project-dvf', 'DVF-1782968049898');

  assert.equal(nextId, 'DVF-0301');
  assert.equal(state.countersCache.DVF, 301);
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
