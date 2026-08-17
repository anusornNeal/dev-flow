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
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');

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
    frozenSpec: spec, primaryScreenId: 'main', screenshotArtifactId: `uisa_${'b'.repeat(32)}`, screenshotWidth: 1200, screenshotHeight: 800,
  });

  const context = getAgentTaskContext({ countersCache: {} }, 'DVF-UICTX', false) as any;
  assert.ok(context);
  assert.ok(context.uiDesignEvidence);
  assert.equal(context.uiDesignEvidence.items.length, 1);
  assert.equal(context.uiDesignEvidence.items[0].frozenRevision, 1);
  assert.equal(context.uiDesignEvidence.items[0].previewId, 'uip_agent_context');
  assert.equal(typeof context.uiDesignEvidence.items[0].screenshotUrl, 'string');
  assert.deepEqual(context.uiDesignEvidence.items[0].specSummary, spec.summary);
  assert.equal(context.uiDesignEvidence.items[0].primaryScreenId, 'main');
  assert.deepEqual(context.uiDesignEvidence.items[0].primaryScreenSummary, spec.summary);
  assert.equal('spec' in context.uiDesignEvidence.items[0], false);
  assert.equal('screenshotArtifactId' in context.uiDesignEvidence.items[0], false);
  const serialized = JSON.stringify(context.uiDesignEvidence);
  assert.doesNotMatch(serialized, /DO-NOT-LEAK-SOURCE|SECRET-CSS|SECRET-JS|absolutePath|png/i);
  assert.ok(context.uiDesignEvidence.limit <= 20);
});

test('agent context keeps current task requirements but bounds child, bug, and optional surrounding context', () => {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews; DELETE FROM tasks;');
  const now = new Date().toISOString();
  saveTask({
    id: 'task-large-parent', displayId: 'DVF-LARGE', title: 'Large parent', projectId: 'project-large',
    status: 'todo', priority: 'high', category: 'general', tags: [], branch: '0507',
    description: 'CURRENT-DESCRIPTION', reasoning: 'CURRENT-REASONING',
    acceptanceCriteria: 'CURRENT-ACCEPTANCE', verification: 'CURRENT-VERIFICATION',
    checklist: [{ id: 'current-check', text: 'CURRENT-CHECKLIST', completed: false }],
    targetFiles: ['src/current.ts'], repoContext: 'CURRENT-REPO-CONTEXT', logs: [{ id: 'log-1', timestamp: now, message: 'LOG-LEAK-'.repeat(1000), type: 'edit' }],
    bugs: [{
      id: 'bug-large', taskId: 'task-large-parent', title: 'Compact bug', status: 'open', source: 'user', severity: 'high',
      actual: 'CURRENT-BUG-ACTUAL', expected: 'CURRENT-BUG-EXPECTED', evidence: 'BUG-EVIDENCE-'.repeat(1000), relatedAreas: ['src/current.ts'],
      versions: [{ version: 1, status: 'open', prompt: 'BUG-PROMPT-'.repeat(1000), summary: 'BUG-SUMMARY-'.repeat(1000), changedFiles: [], createdAt: now, createdBy: 'User' }],
      createdAt: now, updatedAt: now,
    }],
    createdAt: now, updatedAt: now, images: [], designImages: [],
  } as any);
  for (let index = 0; index < 3; index += 1) {
    saveTask({
      id: `task-large-child-${index}`, displayId: `DVF-LARGE-${index}`, title: `Child ${index}`, projectId: 'project-large', parentId: 'task-large-parent',
      status: 'backlog', priority: 'high', category: 'general', tags: [], branch: `child-${index}`,
      description: 'CHILD-DESCRIPTION-LEAK-'.repeat(1000), reasoning: 'CHILD-REASONING-LEAK-'.repeat(1000),
      acceptanceCriteria: 'CHILD-ACCEPTANCE-LEAK-'.repeat(1000), verification: 'CHILD-VERIFICATION-LEAK-'.repeat(1000),
      checklist: [{ id: `child-${index}-check`, text: 'CHILD-CHECKLIST-LEAK-'.repeat(1000), completed: false }],
      targetFiles: [`src/child-${index}.ts`], repoContext: 'CHILD-REPO-LEAK-'.repeat(1000), logs: [], bugs: [],
      createdAt: now, updatedAt: now, images: [], designImages: [],
    } as any);
  }

  const context = getAgentTaskContext({ countersCache: {} }, 'DVF-LARGE', false) as any;
  assert.equal(context.instruction.description, 'CURRENT-DESCRIPTION');
  assert.equal(context.instruction.reasoning, 'CURRENT-REASONING');
  assert.equal(context.requirements.acceptanceCriteria, 'CURRENT-ACCEPTANCE');
  assert.equal(context.requirements.verification, 'CURRENT-VERIFICATION');
  assert.equal(context.requirements.checklist[0].text, 'CURRENT-CHECKLIST');
  assert.deepEqual(context.requirements.targetFiles, ['src/current.ts']);
  assert.equal(context.repoContext, 'CURRENT-REPO-CONTEXT');
  assert.equal(context.orchestration.role, 'parent');
  assert.equal(context.orchestration.subtasks.length, 3);
  assert.deepEqual(context.orchestration.subtasks[0].targetFiles, ['src/child-0.ts']);
  const serialized = JSON.stringify(context);
  for (const leaked of ['CHILD-DESCRIPTION-LEAK-', 'CHILD-REASONING-LEAK-', 'CHILD-ACCEPTANCE-LEAK-', 'CHILD-VERIFICATION-LEAK-', 'CHILD-CHECKLIST-LEAK-', 'CHILD-REPO-LEAK-', 'BUG-SUMMARY-', 'LOG-LEAK-']) {
    assert.equal(serialized.includes(leaked), false, `agent context should not include ${leaked}`);
  }
  assert.equal('json' in context.bugSummary, false);
  assert.equal('markdown' in context.bugSummary, false);
  assert.equal('bugThreads' in context.bugSummary, false);
  assert.equal(context.bugSummary.unresolvedBugCount, 1);
  assert.equal(context.bugSummary.latestUnresolvedBug.title, 'Compact bug');
  assert.ok(Buffer.byteLength(serialized, 'utf8') < 16000, `agent context should stay bounded, got ${Buffer.byteLength(serialized, 'utf8')} bytes`);
});
