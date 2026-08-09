import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-recovery-runtime-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.sqlite');
const repoRoot = path.join(tempDir, 'repo');
fs.mkdirSync(repoRoot, { recursive: true });

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { readFileSnippetsBatch } = await import('../../src/server/services/localFileService.js');
const { applyPreparedEditPlan, prepareEditPlan } = await import('../../src/server/services/preparedEditService.js');
const { executeRecoveryAwareTool } = await import('../../src/server/services/devFlowRecoveryRuntime.js');

const project = {
  id: 'project-recovery-runtime',
  name: 'Recovery Runtime Fixture',
  repoUrl: 'https://example.com/recovery-runtime',
  localPath: repoRoot,
};
createProject(project);
const state: any = { projectsCache: [project] };

test('runtime recovers BATCH_BYTE_LIMIT by splitting the semantic batch internally', async () => {
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) {
    fs.writeFileSync(path.join(repoRoot, name), `${name}:${'x'.repeat(105)}\n`, 'utf8');
  }
  const args = {
    projectId: project.id,
    maxTotalBytes: 250,
    allowPartial: true,
    files: ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((filePath) => ({ filePath, maxBytes: 120 })),
  };
  const raw: any = readFileSnippetsBatch(state, args);
  assert.equal(raw.files.some((entry: any) => entry?.error?.code === 'BATCH_BYTE_LIMIT'), true);

  const recovered: any = await executeRecoveryAwareTool(
    state,
    'read_file_snippets_batch',
    args,
    (payload) => readFileSnippetsBatch(state, payload),
  );
  assert.equal(recovered.count, 4);
  assert.equal(recovered.successCount, 4);
  assert.equal(recovered.errorCount, 0);
  assert.equal(recovered.files.some((entry: any) => entry?.error?.code === 'BATCH_BYTE_LIMIT'), false);
  assert.deepEqual(recovered.files.map((entry: any) => path.basename(entry.path)), ['a.txt', 'b.txt', 'c.txt', 'd.txt']);
});

test('runtime turns stale prepared edit into a fresh preview and never auto-applies it', async () => {
  const target = path.join(repoRoot, 'edit.txt');
  fs.writeFileSync(target, 'alpha one\n', 'utf8');
  const prepared: any = prepareEditPlan(state, {
    projectId: project.id,
    files: [{ filePath: 'edit.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'two' }] }],
  });
  assert.equal(prepared.ok, true);

  fs.writeFileSync(target, 'prefix alpha one\n', 'utf8');
  const recovered: any = await executeRecoveryAwareTool(
    state,
    'apply_prepared_edit',
    { editPlanId: prepared.editPlanId },
    (payload) => applyPreparedEditPlan(payload),
  );

  assert.equal(recovered.ok, false);
  assert.equal(recovered.code, 'EDIT_PLAN_STALE');
  assert.equal(recovered.recoveryEngine.outcome, 'preview-ready');
  assert.equal(recovered.recoveryEngine.requiresExplicitApply, true);
  assert.equal(recovered.freshPreview.preview.ok, true);
  assert.notEqual(recovered.freshPreview.editPlanId, prepared.editPlanId);
  assert.equal(fs.readFileSync(target, 'utf8'), 'prefix alpha one\n');

  const explicitApply: any = applyPreparedEditPlan({ editPlanId: recovered.freshPreview.editPlanId });
  assert.equal(explicitApply.ok, true);
  assert.equal(fs.readFileSync(target, 'utf8'), 'prefix alpha two\n');
});

test.after(() => {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
