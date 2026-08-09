import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-steno-session-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { readLocalFile } = await import('../../src/server/services/localFileService.js');
const { prepareCompactEdit } = await import('../../src/server/services/stenoEditProtocolService.js');
const { applyPreparedEditPlan, clearPreparedEditPlans } = await import('../../src/server/services/preparedEditService.js');
const { clearFileReferences, resolveFileRef } = await import('../../src/server/services/fileReferenceService.js');
const { resetSessionWorkspaceRuntimeForTests, createOrReuseSessionWorkspace } = await import('../../src/server/services/sessionWorkspaceService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
}

function createRepo() {
  const root = path.join(tempRoot, 'repo');
  fs.mkdirSync(root, { recursive: true });
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n', 'utf8');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

test.beforeEach(() => {
  clearFileReferences();
  clearPreparedEditPlans();
  resetSessionWorkspaceRuntimeForTests();
});

test('Steno fileRef and prepared edit stay bound to the isolated session workspace', () => {
  const repo = createRepo();
  const project = { id: 'project-steno-session', name: 'Steno Session', repoUrl: 'https://example.test/steno-session.git', localPath: repo };
  createProject(project as any);
  const state: any = { projectsCache: [project] };

  const read = readLocalFile(state, {
    projectId: project.id,
    sessionId: 'chat-steno',
    filePath: 'README.md',
    includeFileRef: true,
  });
  assert.match(read.fileRef || '', /^file-ref-/);
  assert.throws(
    () => resolveFileRef(state, { projectId: project.id }, read.fileRef || ''),
    (error: unknown) => (error as any)?.payload?.code === 'EDIT_REF_PROJECT_MISMATCH',
  );

  const prepared = prepareCompactEdit(state, {
    projectId: project.id,
    sessionId: 'chat-steno',
    v: 1,
    f: [[read.fileRef, [['R', 'base', 'workspace-only', 1]]]],
  });
  assert.equal(prepared.ok, true);
  assert.ok(prepared.editPlanId);

  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId });
  assert.equal(applied.ok, true);

  const workspace = createOrReuseSessionWorkspace(project as any, 'chat-steno');
  assert.equal(fs.readFileSync(path.join(workspace.root, 'README.md'), 'utf8').trim(), 'workspace-only');
  assert.equal(fs.readFileSync(path.join(repo, 'README.md'), 'utf8').trim(), 'base');
});

test.after(() => {
  clearFileReferences();
  clearPreparedEditPlans();
  resetSessionWorkspaceRuntimeForTests();
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
