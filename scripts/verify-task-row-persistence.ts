import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-row-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

try {
  const db = (await import('../src/db/index.js')).default;
  const { deleteTasksByIds, saveTask, getTasks } = await import('../src/server/repositories/taskRepository.js');

  const state = {
    tasksCache: [],
    projectsCache: [],
    countersCache: {},
    
    skillsRegistry: [],
  };

  db.prepare('INSERT INTO projects (id, name, taskIdPrefix) VALUES (?, ?, ?)').run('p-row', 'Row Persist', 'ROW');
  db.prepare('INSERT INTO tasks (id, displayId, title, projectId, status, priority, category, tags, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    't-keep',
    'ROW-0001',
    'Keep me',
    'p-row',
    'todo',
    'medium',
    'general',
    JSON.stringify(['stable']),
    '2026-06-19T00:00:00.000Z',
    '2026-06-19T00:00:00.000Z',
  );

  saveTask({
    id: 't-new',
    displayId: 'ROW-0002',
    title: 'New row',
    description: 'inserted without rewriting the table',
    projectId: 'p-row',
    status: 'backlog',
    priority: 'low',
    category: 'backend',
    tags: ['fast-write'],
    checklist: [{ id: 'c1', text: 'persist one row', completed: false }],
    logs: [],
    createdAt: '2026-06-19T01:00:00.000Z',
    updatedAt: '2026-06-19T01:00:00.000Z',
  });

  let rows = db.prepare('SELECT id, title, category, tags, checklist FROM tasks ORDER BY id').all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === 't-keep')?.title, 'Keep me');
  assert.deepEqual(JSON.parse(rows.find((row) => row.id === 't-new')?.tags), ['fast-write']);
  assert.equal(JSON.parse(rows.find((row) => row.id === 't-new')?.checklist).length, 1);

  saveTask({
    id: 't-new',
    displayId: 'ROW-0002',
    title: 'Updated row',
    projectId: 'p-row',
    status: 'todo',
    priority: 'high',
    category: 'frontend',
    tags: ['updated'],
    checklist: [],
    logs: [],
    createdAt: '2026-06-19T01:00:00.000Z',
    updatedAt: '2026-06-19T02:00:00.000Z',
  });

  rows = db.prepare('SELECT id, title, category, tags FROM tasks ORDER BY id').all() as any[];
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === 't-new')?.title, 'Updated row');
  assert.equal(rows.find((row) => row.id === 't-new')?.category, 'frontend');
  assert.equal(rows.find((row) => row.id === 't-keep')?.title, 'Keep me');

  deleteTasksByIds(['t-new']);
  rows = db.prepare('SELECT id FROM tasks ORDER BY id').all() as any[];
  assert.deepEqual(rows.map((row) => row.id), ['t-keep']);

  
  assert.equal(getTasks().length, 1);
  assert.equal(getTasks()[0].id, 't-keep');

  console.log('[verify-task-row-persistence] all assertions passed');
} finally {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup failures on Windows if a handle is still being released
  }
}
