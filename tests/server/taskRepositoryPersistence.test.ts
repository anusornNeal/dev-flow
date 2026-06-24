import { executeAllMigrations } from '../../src/db/migrations/index.js';
executeAllMigrations();
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../../src/db/index';
import { deleteTask, getTask, saveTask } from '../../src/server/repositories/taskRepository';

function makeTask(id: string, title: string, createdAt = new Date().toISOString()) {
  const now = new Date().toISOString();
  return {
    id,
    displayId: `TEST-${id.slice(-6)}`,
    title,
    description: 'persistence regression test task',
    projectId: null,
    status: 'todo',
    priority: 'medium',
    branch: null,
    category: 'general',
    tags: [],
    targetFiles: [],
    checklist: [],
    effort: null,
    model: null,
    agent: null,
    parentId: null,
    reasoning: null,
    acceptanceCriteria: null,
    verification: null,
    repoContext: null,
    jiraKey: null,
    repo: null,
    createdAt,
    updatedAt: now,
    logs: [],
    images: [],
  };
}

test('server taskRepository.saveTask updates without deleting dependent attachments', () => {
  const taskId = `task-persist-${randomUUID()}`;
  const attachmentId = `att-persist-${randomUUID()}`;

  try {
    const first = makeTask(taskId, 'before');
    saveTask(first);
    db.prepare(`
      INSERT INTO attachments (id, taskId, projectId, kind, originalName, storedName, mimeType, sizeBytes, relativePath, createdAt, updatedAt, deletedAt)
      VALUES (?, ?, NULL, 'file', 'note.txt', 'note.txt', 'text/plain', 1, 'attachments/note.txt', ?, NULL, NULL)
    `).run(attachmentId, taskId, new Date().toISOString());

    saveTask(makeTask(taskId, 'after', first.createdAt));

    const row = db.prepare('SELECT COUNT(*) as count FROM attachments WHERE id = ? AND taskId = ?').get(attachmentId, taskId) as { count: number };
    assert.equal(row.count, 1);
    assert.equal(getTask(taskId)?.title, 'after');
  } finally {
    deleteTask(taskId);
  }
});
