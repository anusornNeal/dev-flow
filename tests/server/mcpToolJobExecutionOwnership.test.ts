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
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');
const { runBuiltinToolJob } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');

const projectId = 'project-mcp-execution-ownership';
const taskId = 'task-mcp-execution-ownership';
createProject({ id: projectId, name: 'Ownership Fixture', repoUrl: 'https://example.com/ownership', localPath: repoRoot });
workspaceService.resetSessionWorkspaceRuntimeForTests();
const workspace = workspaceService.createOrReuseSessionWorkspace({ id: projectId, localPath: repoRoot }, 'ownership');
const session = execution.createExecutionSession({
  projectId,
  taskId,
  workspaceId: workspace.workspaceId,
  repoRoot: workspace.root,
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

test('task-bound MCP edit and verification populate commit ownership without adopting unrelated dirt', async () => {
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
  assert.equal(fs.readFileSync(path.join(workspace.root, 'src', 'owned.ts'), 'utf8').trim(), 'export const owned = 2;');

  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 2;\n');

  const verified = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: {
      projectId,
      workspaceId: workspace.workspaceId,
      command: 'test',
      cacheResult: false,
      forceFresh: true,
      singleFlight: false,
    },
  }, context as any) as any;
  assert.equal(verified.ok, true);
  assert.equal(verified.status, 'succeeded');

  const ownership = execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.deepEqual(ownership.ownedChanges, ['src/owned.ts']);
  assert.deepEqual(ownership.unrelatedChanges, ['src/unrelated.ts']);
  assert.equal(ownership.verificationFresh, true);

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, ['src/owned.ts']);
  assert.deepEqual(plan.unrelatedChangedFiles, ['src/unrelated.ts']);
  assert.equal(plan.verificationFresh, true);
});

test('failed MCP verification does not refresh ownership evidence', async () => {
  const editedAgain = await runBuiltinToolJob({
    toolName: 'edit_local_files_batch',
    state,
    args: {
      projectId,
      workspaceId: workspace.workspaceId,
      mode: 'apply',
      files: [
        { filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 2', replaceWith: 'owned = 3' }] },
      ],
    },
  }, context as any) as any;
  assert.equal(editedAgain.ok, true);
  assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, false);

  const failed = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: {
      projectId,
      workspaceId: workspace.workspaceId,
      command: 'fail-check',
      cacheResult: false,
      forceFresh: true,
      singleFlight: false,
    },
  }, context as any) as any;
  assert.equal(failed.ok, false);
  assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, false);
});
