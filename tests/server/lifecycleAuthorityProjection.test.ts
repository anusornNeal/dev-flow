import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-lifecycle-projection-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.test']);
git(['add', '.']);
git(['commit', '-m', 'base']);
git(['branch', '-M', 'overhaul-devflow']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const claims = await import('../../src/server/services/taskClaimService.js');
const workspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const authority = await import('../../src/server/services/lifecycleAuthorityService.js');

const project = {
  id: 'project-lifecycle-projection',
  name: 'Lifecycle Projection',
  repoUrl: 'https://example.test/lifecycle-projection.git',
  localPath: repoRoot,
  taskIdPrefix: 'LAP',
  createdAt: new Date().toISOString(),
};
createProject(project as any);
workspaces.resetSessionWorkspaceRuntimeForTests();

const now = new Date().toISOString();
const taskId = 'task-lifecycle-projection';
saveTask({
  id: taskId,
  displayId: 'LAP-0001',
  projectId: project.id,
  title: 'projection-only evidence',
  description: 'test fixture',
  status: 'todo',
  priority: 'high',
  category: 'backend',
  tags: [],
  targetFiles: ['src/A.ts'],
  checklist: [],
  createdAt: now,
  updatedAt: now,
  logs: [],
  bugs: [],
  images: [],
} as any);

test('task review evidence remains projection-only while execution evidence owns managed authority', () => {
  const claimed = claims.claimTaskForSession(taskId, { sessionId: 'projection-worker', ownerKind: 'chat', ownerLabel: 'Projection Worker' });
  const task = getTask(taskId)!;
  task.gitEvidence = {
    evidenceSource: 'project-root',
    branch: 'review-only',
    commit: 'review-commit',
    pushed: true,
    workingTreeClean: true,
    recordedAt: new Date().toISOString(),
  } as any;
  task.verificationEvidence = [{
    name: 'review-only',
    command: 'review:test',
    status: 'passed',
    scope: 'full',
    repoRevision: 'review-commit',
  }] as any;
  saveTask(task);

  const snapshot = authority.computeLifecycleAuthoritySnapshot(taskId, { workspaceId: claimed.claim.workspaceId });
  assert.equal(snapshot.verification.fresh, null, 'review projection must not make managed verification fresh');
  assert.equal((snapshot.finalization as any).authoritySource, 'execution-finalization');
  assert.equal((snapshot.finalization as any).taskEvidenceRole, 'projection-only');
  assert.equal(snapshot.finalization.gitEvidence?.commit, 'review-commit', 'projection remains readable for UI/audit compatibility');
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
