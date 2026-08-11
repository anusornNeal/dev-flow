import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-ui-board-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { queryTaskBoardPage } = await import('../../src/server/repositories/taskRepository.js');
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createTaskUiEvidenceRepository } = await import('../../src/server/repositories/taskUiEvidenceRepository.js');

const previewRepository = createUiPreviewRepository(db as any);
const evidenceRepository = createTaskUiEvidenceRepository(db as any);
const spec = { schemaVersion: 1 as const, summary: { screen: 'Board design' } };
const viewport = { width: 800, height: 600, deviceScaleFactor: 1 };

test('board query exposes one lightweight hasUiDesign signal from current evidence', () => {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO tasks (id, title, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)')
    .run('task-board-design', 'Board design task', 'todo', now, now);

  const before = queryTaskBoardPage({ limit: 10 });
  assert.equal(before.items.find((item: any) => item.id === 'task-board-design')?.hasUiDesign, false);

  previewRepository.createPreview({
    id: 'uip_board_design',
    taskId: 'task-board-design',
    title: 'Board design',
    html: '<main>design</main>',
    css: '',
    js: '',
    spec,
    viewport,
    contentHash: 'board-design-v1',
    createdAt: now,
  });
  evidenceRepository.recordEvidence({
    evidenceId: 'uie_board_design',
    taskId: 'task-board-design',
    previewId: 'uip_board_design',
    frozenRevision: 1,
    frozenSpec: spec,
    screenshotArtifactId: 'uisa_00000000000000000000000000000001',
    screenshotWidth: 800,
    screenshotHeight: 600,
  });

  const after = queryTaskBoardPage({ limit: 10 });
  assert.equal(after.items.find((item: any) => item.id === 'task-board-design')?.hasUiDesign, true);
  assert.equal('uiEvidence' in after.items[0], false);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
