import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-evidence-agent-context-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createTaskUiEvidenceRepository } = await import('../../src/server/repositories/taskUiEvidenceRepository.js');
const { getAgentTaskContext } = await import('../../src/server/services/taskService.js');

const previewRepo = createUiPreviewRepository(db as any);
const evidenceRepo = createTaskUiEvidenceRepository(db as any);
const spec = { schemaVersion: 1 as const, summary: { screen: 'Agent context' }, layout: { sections: ['main'] } };
const viewport = { width: 1200, height: 800, deviceScaleFactor: 1 };

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

test('agent context includes bounded frozen UI evidence metadata without preview source, screenshot bytes, or artifact paths', () => {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews; DELETE FROM tasks;');
  db.prepare('INSERT INTO tasks (id, displayId, title, status, priority, projectId) VALUES (?, ?, ?, ?, ?, ?)')
    .run('task-agent-ui', 'DVF-UICTX', 'Agent UI context', 'todo', 'high', 'project-agent-ui');
  previewRepo.createPreview({
    id: 'uip_agent_context', taskId: 'task-agent-ui', title: 'Frozen screen',
    html: '<main>DO-NOT-LEAK-SOURCE</main>', css: 'SECRET-CSS', js: 'SECRET-JS', spec, viewport, contentHash: 'hash-agent',
  });
  evidenceRepo.recordEvidence({
    evidenceId: 'uie_agent_context', taskId: 'task-agent-ui', previewId: 'uip_agent_context', frozenRevision: 1,
    frozenSpec: spec, screenshotArtifactId: `uisa_${'b'.repeat(32)}`, screenshotWidth: 1200, screenshotHeight: 800,
  });

  const context = getAgentTaskContext({ countersCache: {} }, 'DVF-UICTX', false) as any;
  assert.ok(context);
  assert.ok(context.uiDesignEvidence);
  assert.equal(context.uiDesignEvidence.items.length, 1);
  assert.equal(context.uiDesignEvidence.items[0].frozenRevision, 1);
  assert.deepEqual(context.uiDesignEvidence.items[0].specSummary, spec.summary);
  assert.equal('screenshotArtifactId' in context.uiDesignEvidence.items[0], false);
  const serialized = JSON.stringify(context.uiDesignEvidence);
  assert.doesNotMatch(serialized, /DO-NOT-LEAK-SOURCE|SECRET-CSS|SECRET-JS|absolutePath|png/i);
  assert.ok(context.uiDesignEvidence.limit <= 20);
});
