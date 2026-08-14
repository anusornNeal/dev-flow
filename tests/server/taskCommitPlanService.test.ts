import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-commit-plan-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
const repoRoot = path.join(tempRoot, 'repo');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'owned.ts'), 'export const owned = 1;\n');
fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = 1;\n');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

git(repoRoot, ['init']);
git(repoRoot, ['config', 'user.name', 'DevFlow Test']);
git(repoRoot, ['config', 'user.email', 'devflow@example.test']);
git(repoRoot, ['add', '.']);
git(repoRoot, ['commit', '-m', 'base']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');

function createFixture(label: string) {
  workspaceService.resetSessionWorkspaceRuntimeForTests();
  const projectId = `project-${label}`;
  const workspace = workspaceService.createOrReuseSessionWorkspace({ id: projectId, localPath: repoRoot }, label);
  const taskId = `task-${label}`;
  const session = execution.createExecutionSession({ projectId, taskId, workspaceId: workspace.workspaceId, repoRoot: workspace.root });
  return { workspace, taskId, session };
}

test('commit plan selects only execution-owned changed files and preserves unrelated changes', () => {
  const { workspace, taskId, session } = createFixture('scoped');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 2;\n');
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 2;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, ['src/owned.ts']);
  assert.deepEqual(plan.unrelatedChangedFiles, ['src/unrelated.ts']);
  assert.equal(plan.verificationFresh, true);

  const committed = commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'fix(scope): scoped owned change' });
  assert.deepEqual(committed.committedFiles, ['src/owned.ts']);
  assert.deepEqual(committed.unrelatedChangesPreserved, ['src/unrelated.ts']);
  assert.match(git(workspace.root, ['status', '--porcelain']), /src\/unrelated\.ts/);
  assert.doesNotMatch(git(workspace.root, ['status', '--porcelain']), /src\/owned\.ts/);
  assert.equal(git(workspace.root, ['log', '-1', '--pretty=%s']), '[task-scoped] fix: scoped owned change');
});

test('commit plan matches execution-owned files inside a wholly new nested directory', () => {
  const { workspace, taskId, session } = createFixture('new-nested');
  const ownedPath = 'src/generated/region/RegionSummary.kt';
  fs.mkdirSync(path.dirname(path.join(workspace.root, ownedPath)), { recursive: true });
  fs.writeFileSync(path.join(workspace.root, ownedPath), 'class RegionSummary\n');
  execution.recordExecutionOwnedChanges(session.id, [ownedPath], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, [ownedPath]);
  assert.deepEqual(plan.unrelatedChangedFiles, []);
  assert.deepEqual(plan.scopeDrift, []);
});

test('commit plan blocks stale verification after an owned file changes again', () => {
  const { workspace, taskId, session } = createFixture('stale');
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 3;\n');
  execution.recordExecutionOwnedChanges(session.id, ['src/owned.ts'], { repoRoot: workspace.root, source: 'task-edit' });
  execution.recordExecutionVerificationEvidence(session.id, [{ name: 'focused', status: 'passed' }], { repoRoot: workspace.root });
  fs.writeFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'export const owned = 4;\n');

  const plan = commitPlan.buildTaskCommitPlan({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, false);
  assert.equal(plan.verificationFresh, false);
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_OWNERSHIP_DRIFT'));
  assert.ok(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
  assert.throws(() => commitPlan.commitTaskOwnedChanges({ countersCache: {} }, { taskId, workspaceId: workspace.workspaceId, message: 'should not commit' }), /blocked/i);
});
