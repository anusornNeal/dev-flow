import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { executeAllMigrations } from '../../src/db/migrations/index.js';
import { createExecutionSessionRecord, updateExecutionSessionRecord } from '../../src/server/repositories/executionSessionRepository.js';
import { createOrReuseSessionWorkspace, resetSessionWorkspaceRuntimeForTests } from '../../src/server/services/sessionWorkspaceService.js';
import { finalizeSupersededWorkspace, inspectWorkspaceRecovery } from '../../src/server/services/workspaceRecoveryService.js';

const recoveryLifecycleDbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-recovery-lifecycle-db-'));
process.env.DEVFLOW_DB_PATH = path.join(recoveryLifecycleDbRoot, 'devflow.db');
executeAllMigrations();
let recoveryExecutionCounter = 0;

function git(root: string, args: string[], allowFailure = false) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (!allowFailure) assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return { status: result.status ?? -1, stdout: (result.stdout || '').trim(), stderr: (result.stderr || '').trim() };
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-recovery-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  fs.writeFileSync(path.join(root, 'package.json'), '{"test":"verify"}\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

function project(root: string) {
  return { id: `project-${path.basename(root)}`, name: 'Recovery Fixture', localPath: root } as any;
}

function beginFixture(label: string) {
  process.env.DEVFLOW_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), `devflow-recovery-runtime-${label}-`));
  resetSessionWorkspaceRuntimeForTests();
  const root = createRepo();
  const workspace = createOrReuseSessionWorkspace(project(root), label);
  return { root, workspace };
}

function createActiveRecoveryExecution(workspace: { workspaceId: string; projectId: string; branch: string; baseRevision: string }) {
  recoveryExecutionCounter += 1;
  const now = new Date().toISOString();
  return createExecutionSessionRecord({
    id: `workspace-recovery-exec-${recoveryExecutionCounter}`,
    projectId: workspace.projectId,
    taskId: null,
    workspaceId: workspace.workspaceId,
    branch: workspace.branch,
    baseRevision: workspace.baseRevision,
    repoRevision: workspace.baseRevision,
    status: 'active',
    contextHandle: null,
    createdAt: now,
    updatedAt: now,
    expiresAt: null,
    endedAt: null,
  });
}

test('inspection recognizes clean recreated patch as patch-equivalent', () => {
  const { root, workspace } = beginFixture('equivalent');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'new\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', 'old implementation']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'new\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'recreated implementation']);

  const inspection = inspectWorkspaceRecovery(workspace.workspaceId);
  assert.equal(inspection.disposition, 'patch-equivalent');
  assert.equal(inspection.dirtyFiles.length, 0);
  assert.equal(inspection.uniqueCommits.length, 0);
  assert.ok(inspection.sourceCommits.length > 0);
});

test('finalize superseded workspace refuses patch-equivalent cleanup while a live execution still owns the workspace', () => {
  const { root, workspace } = beginFixture('equivalent-owned');
  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'new\n');
  git(workspace.root, ['add', 'tracked.txt']);
  git(workspace.root, ['commit', '-m', 'old implementation']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'new\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'recreated implementation']);
  const replacement = git(root, ['rev-parse', 'HEAD']).stdout;
  assert.equal(inspectWorkspaceRecovery(workspace.workspaceId).disposition, 'patch-equivalent');
  const execution = createActiveRecoveryExecution(workspace);

  assert.throws(
    () => finalizeSupersededWorkspace(workspace.workspaceId, { supersededByCommit: replacement }),
    (error: any) => error?.payload?.code === 'WORKSPACE_LIFECYCLE_AUTHORITY_ACTIVE',
  );
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], true).status, 0);

  const endedAt = new Date().toISOString();
  updateExecutionSessionRecord(execution.id, { status: 'completed', updatedAt: endedAt, endedAt });
  const result = finalizeSupersededWorkspace(workspace.workspaceId, { supersededByCommit: replacement });
  assert.equal(result.status, 'cleaned');
  assert.equal(fs.existsSync(workspace.root), false);
});

test('finalize superseded workspace discards only proven-equivalent dirty work and explicit temporary files', () => {
  const { root, workspace } = beginFixture('dirty-superseded');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'implemented\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'replacement implementation']);
  const replacement = git(root, ['rev-parse', 'HEAD']).stdout;

  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'implemented\n');
  fs.writeFileSync(path.join(workspace.root, 'package.json'), '{"test":"focused"}\n');
  const before = inspectWorkspaceRecovery(workspace.workspaceId);
  assert.equal(before.disposition, 'needs-recovery');
  assert.deepEqual(before.dirtyFiles, ['package.json', 'tracked.txt']);

  const result = finalizeSupersededWorkspace(workspace.workspaceId, {
    supersededByCommit: replacement,
    temporaryPaths: ['package.json'],
  });
  assert.equal(result.status, 'cleaned');
  assert.deepEqual(result.discardedFiles, ['package.json', 'tracked.txt']);
  assert.equal(fs.existsSync(workspace.root), false);
  assert.notEqual(git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`], true).status, 0);
});

test('finalize superseded workspace preserves ambiguous dirty content', () => {
  const { root, workspace } = beginFixture('dirty-ambiguous');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'implemented\n');
  git(root, ['add', 'tracked.txt']);
  git(root, ['commit', '-m', 'replacement implementation']);
  const replacement = git(root, ['rev-parse', 'HEAD']).stdout;

  fs.writeFileSync(path.join(workspace.root, 'tracked.txt'), 'different unique work\n');
  const result = finalizeSupersededWorkspace(workspace.workspaceId, { supersededByCommit: replacement });
  assert.equal(result.status, 'needs-recovery');
  assert.deepEqual(result.unsafeFiles, ['tracked.txt']);
  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(fs.readFileSync(path.join(workspace.root, 'tracked.txt'), 'utf8'), 'different unique work\n');
});
