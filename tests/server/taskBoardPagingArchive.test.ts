import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-board-paging-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const db = (await import('../../src/db/index.js')).default;
const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  archiveInactiveDoneTasks,
  getTask,
  queryTaskBoardPage,
  restoreArchivedTask,
  saveTask,
} = await import('../../src/server/repositories/taskRepository.js');

const project = {
  id: 'project-board-paging',
  name: 'Board Paging',
  repoUrl: 'https://example.com/board-paging',
  localPath: tempDir,
};
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };

function makeTask(index: number, status: string, updatedAt: string) {
  const suffix = String(index).padStart(4, '0');
  return {
    id: `task-board-${status}-${suffix}`,
    displayId: `DVF-${suffix}`,
    title: `${status} task ${suffix}`,
    description: 'Board paging fixture',
    projectId: project.id,
    status,
    priority: index % 2 === 0 ? 'high' : 'medium',
    tags: [],
    checklist: [],
    logs: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

for (let index = 0; index < 60; index += 1) {
  saveTask(makeTask(index, 'todo', `2999-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`));
}
for (let index = 100; index < 112; index += 1) {
  saveTask(makeTask(index, 'done', '2999-02-01T00:00:00.000Z'));
}
for (let index = 200; index < 230; index += 1) {
  saveTask(makeTask(index, 'done', '2020-01-01T00:00:00.000Z'));
}
saveTask(makeTask(300, 'done', '2026-05-10T00:00:00.000Z'));
saveTask(makeTask(301, 'done', '2020-01-01T00:00:00.000Z'));
db.prepare(`
  INSERT INTO agent_runs (id, taskId, projectId, agent, status, createdAt, endedAt)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`).run(
  'run-board-recent-activity',
  'task-board-done-0301',
  project.id,
  'Codex',
  'succeeded',
  '2026-08-01T00:00:00.000Z',
  '2026-08-01T00:05:00.000Z',
);

test('006 migration adds archive column and board indexes', () => {
  const columns = db.pragma('table_info(tasks)') as Array<{ name: string }>;
  assert.equal(columns.some((column) => column.name === 'archivedAt'), true);
  const indexes = db.pragma('index_list(tasks)') as Array<{ name: string }>;
  assert.equal(indexes.some((index) => index.name === 'idx_tasks_board_page'), true);
  assert.equal(indexes.some((index) => index.name === 'idx_tasks_archive_age'), true);
});

test('queryTaskBoardPage pages in SQL and hydrates only the requested page', () => {
  const first = queryTaskBoardPage({ projectId: project.id, status: 'todo', limit: 25, offset: 0 });
  const second = queryTaskBoardPage({ projectId: project.id, status: 'todo', limit: 25, offset: 25 });
  assert.equal(first.items.length, 25);
  assert.equal(first.total, 60);
  assert.equal(first.hasMore, true);
  assert.equal(second.items.length, 25);
  assert.equal(second.offset, 25);
  assert.equal(second.hasMore, true);
  assert.equal(new Set([...first.items, ...second.items].map((task: any) => task.id)).size, 50);
  assert.equal(first.hydratedTaskCount, 25);
});

test('board page query uses the board paging index for lane reads', () => {
  const plan = db.prepare(`
    EXPLAIN QUERY PLAN
    SELECT * FROM tasks
    WHERE projectId = ? AND status = ? AND archivedAt IS NULL AND (parentId IS NULL OR parentId = '')
    ORDER BY createdAt DESC, id DESC
    LIMIT 25 OFFSET 0
  `).all(project.id, 'todo') as Array<{ detail: string }>;
  assert.match(plan.map((row) => row.detail).join('\n'), /idx_tasks_board_page/i);
});

test('auto archive covers inactive backlog, todo, and done while restore prevents immediate re-archive', () => {
  saveTask(makeTask(302, 'backlog', '2020-01-01T00:00:00.000Z'));
  saveTask(makeTask(303, 'todo', '2020-01-01T00:00:00.000Z'));
  const result = archiveInactiveDoneTasks({
    now: '2026-08-08T00:00:00.000Z',
    cutoff: '2026-05-10T00:00:00.000Z',
  });
  assert.equal(result.archivedCount, 32);
  assert.equal(typeof getTask('task-board-backlog-0302')?.archivedAt, 'string');
  assert.equal(typeof getTask('task-board-todo-0303')?.archivedAt, 'string');

  const activeDone = queryTaskBoardPage({ projectId: project.id, status: 'done', limit: 25, offset: 0 });
  assert.equal(activeDone.total, 14);
  const archived = queryTaskBoardPage({ projectId: project.id, status: 'done', archived: true, limit: 50, offset: 0 });
  assert.equal(archived.total, 30);
  assert.equal(archived.items.every((task: any) => typeof task.archivedAt === 'string'), true);
  assert.equal(getTask('task-board-done-0300')?.archivedAt, null, 'exact 90-day boundary should remain active');
  assert.equal(getTask('task-board-done-0301')?.archivedAt, null, 'recent agent activity should prevent archive');

  const restored = restoreArchivedTask(archived.items[0].id, '2026-08-08T01:00:00.000Z');
  assert.equal(restored?.archivedAt, null);
  assert.equal(getTask(archived.items[0].id)?.archivedAt, null);
  const rerun = archiveInactiveDoneTasks({
    now: '2026-08-08T02:00:00.000Z',
    cutoff: '2026-05-10T00:00:00.000Z',
  });
  assert.equal(rerun.archivedCount, 0);
});

test('archived task still resolves by direct id', () => {
  const archived = queryTaskBoardPage({ projectId: project.id, status: 'done', archived: true, limit: 1, offset: 0 });
  assert.equal(archived.items.length, 1);
  const direct = getTask(archived.items[0].id);
  assert.equal(direct?.id, archived.items[0].id);
  assert.equal(typeof direct?.archivedAt, 'string');
});

const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind board paging test server');
const baseUrl = `http://127.0.0.1:${address.port}`;

test('board API exposes lane paging metadata, excludes archived by default, and can restore', async () => {
  const response = await fetch(`${baseUrl}/api/tasks?mode=board&projectId=${project.id}&status=todo&limit=25&offset=0`);
  assert.equal(response.status, 200);
  const body = await response.json() as any;
  assert.equal(body.items.length, 25);
  assert.equal(body.total, 60);
  assert.equal(body.hasMore, true);
  assert.equal(body.archived, false);
  assert.equal(body.hydratedTaskCount, 25);

  const archivedResponse = await fetch(`${baseUrl}/api/tasks?mode=board&projectId=${project.id}&status=done&archived=true&limit=10&offset=0`);
  const archivedBody = await archivedResponse.json() as any;
  assert.equal(archivedBody.total > 0, true);
  assert.equal(typeof archivedBody.items[0].archivedAt, 'string');
  const target = archivedBody.items[0];
  const restoreResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(target.id)}/restore`, { method: 'POST' });
  assert.equal(restoreResponse.status, 200);
  const restoreBody = await restoreResponse.json() as any;
  assert.equal(restoreBody.task.archivedAt, null);
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
