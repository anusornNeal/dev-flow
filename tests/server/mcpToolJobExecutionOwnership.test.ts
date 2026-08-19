import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mcp-execution-ownership-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
const repoRoot = path.join(tempRoot, 'repo');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
  name: 'execution-ownership-fixture',
  private: true,
  scripts: { test: 'node -e "process.stdout.write(\'green\')"' },
}, null, 2));
fs.mkdirSync(path.join(repoRoot, '.devflow'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, '.devflow', 'commands.yaml'), [
  'commands:',
  '  fail-check:',
  '    executable: node',
  '    args:',
  '      - -e',
  "      - process.exit(1)",
  '    category: test',
  '',
].join('\n'));
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
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { claimTaskForSession } = await import('../../src/server/services/taskClaimService.js');
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');
const { runBuiltinToolJob } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');
const { prepareProjectCommandVerificationCandidate } = await import('../../src/server/services/projectCommandService.js');

const projectId = 'project-mcp-execution-ownership';
const taskId = 'task-mcp-execution-ownership';
createProject({ id: projectId, name: 'Ownership Fixture', repoUrl: 'https://example.com/ownership', localPath: repoRoot });
const now = new Date().toISOString();
saveTask({
  id: taskId,
  displayId: 'DVF-OWNERSHIP-0001',
  title: 'Execution ownership fixture',
  description: 'Exercise task-bound MCP verification ownership.',
  projectId,
  status: 'todo',
  priority: 'medium',
  category: 'backend',
  tags: ['ownership'],
  targetFiles: ['src/owned.ts'],
  checklist: [],
  logs: [],
  bugs: [],
  images: [],
  createdAt: now,
  updatedAt: now,
} as any);
workspaceService.resetSessionWorkspaceRuntimeForTests();
const claimed = claimTaskForSession(taskId, {
  sessionId: 'ownership',
  ownerKind: 'chat',
  ownerLabel: 'Ownership test',
});
const workspace = workspaceService.resolveSessionWorkspace(claimed.claim.workspaceId)!;
const session = execution.getActiveTaskExecutionSessionForWorkspace(workspace.workspaceId)!;
execution.recordTaskExecutionContextReady({ workspaceId: workspace.workspaceId }, {
  contextHandle: 'ctx-ownership',
  repoRevision: session.repoRevision,
  contextPlanIdentity: 'plan-ownership',
});
const state: any = {
  countersCache: {},
  projectsCache: [{ id: projectId, name: 'Ownership Fixture', repoUrl: 'https://example.com/ownership', localPath: repoRoot }],
};
const context = {
  logger: { stdout: () => {}, stderr: () => {} },
  setCancelFn: () => {},
  transitionAccess: () => {},
};

function verificationArgs(command: string) {
  const args = {
    projectId,
    workspaceId: workspace.workspaceId,
    command,
    cacheResult: false,
    forceFresh: true,
    singleFlight: false,
  } as any;
  args.__verificationCandidate = prepareProjectCommandVerificationCandidate(state, args);
  assert.ok(args.__verificationCandidate);
  return args;
}

test('failed MCP verification does not create authoritative freshness', async () => {
  const edited = await runBuiltinToolJob({
    toolName: 'edit_local_files_batch',
    state,
    args: {
      projectId,
      workspaceId: workspace.workspaceId,
      mode: 'apply',
      files: [
        { filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] },
      ],
    },
  }, context as any) as any;
  assert.equal(edited.ok, true);
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 2;\n');

  const failed = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: verificationArgs('fail-check'),
  }, context as any) as any;

  assert.equal(failed.ok, false);
  assert.notEqual(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'repairing');
});

test('successful command without authoritative verification binding stays a recovery outcome for Harness', async () => {
  const staleArgs = verificationArgs('test');
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 3;\n');

  const unbound = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: staleArgs,
  }, context as any) as any;

  assert.equal(unbound.ok, true);
  assert.equal(unbound.status, 'succeeded');
  assert.equal(unbound.verificationBinding?.authoritative, false);
  assert.equal(unbound.verificationBinding?.recorderAccepted, false);
  assert.equal(unbound.verificationBinding?.recoveryRequired, true);
  assert.equal(unbound.verificationBinding?.reasonCode, 'EXECUTION_VERIFICATION_CANDIDATE_REQUIRED');
  assert.notEqual(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'repairing');
});

test('task-bound MCP verification binds current ownership before Harness advances', async () => {
  const verified = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: verificationArgs('test'),
  }, context as any) as any;

  assert.equal(verified.ok, true);
  assert.equal(verified.status, 'succeeded');
  assert.equal(verified.verificationBinding?.authoritative, true);
  assert.equal(verified.verificationBinding?.verificationFresh, true);

  const ownership = execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.deepEqual(ownership.ownedChanges, ['src/owned.ts']);
  assert.deepEqual(ownership.unrelatedChanges, ['src/unrelated.ts']);
  assert.equal(ownership.verificationFresh, true);
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'verifying');

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, ['src/owned.ts']);
  assert.deepEqual(plan.unrelatedChangedFiles, ['src/unrelated.ts']);
  assert.equal(plan.verificationFresh, true);
});
