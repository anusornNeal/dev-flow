import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const runnerTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-registry-'));
process.env.DEVFLOW_DB_PATH = path.join(runnerTestRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(runnerTestRoot, 'runtime');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { claimTaskForSession, releaseTaskClaim } = await import('../../src/server/services/taskClaimService.js');
const { cleanupSessionWorkspace } = await import('../../src/server/services/sessionWorkspaceService.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');
const { preflightHarnessExecutionGuard, recordHarnessExecutionOutcome } = await import('../../src/server/services/harnessExecutionGuardService.js');
const { getBuiltinToolRunnerNames, runBuiltinToolJob } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');

const EXPECTED_RUNNERS = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'execute_repo_query_plan',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'commit_task_owned_changes',
  'edit_local_files_batch',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'prepare_compact_edit',
  'apply_prepared_edit',
  'apply_and_verify',
  'delete_local_path',
  'move_local_path',
  'apply_project_atlas_agent_update',
];

test('runner registry owns the complete built-in async dispatch surface', () => {
  assert.deepEqual(getBuiltinToolRunnerNames(), EXPECTED_RUNNERS);
});

test('direct run_project_command retries proven infrastructure failure through a recovery capacity lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-infra-retry-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const marker = path.join(os.tmpdir(), `devflow-runner-infra-retry-${path.basename(root)}.txt`);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test.mjs' } }, null, 2));
  fs.writeFileSync(path.join(root, 'scripts', 'test.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "if (process.env.DEVFLOW_VERIFICATION_RECOVERY !== 'resource-safe') { process.stderr.write('java.lang.OutOfMemoryError: Java heap space\\n'); process.exit(1); }",
    "process.stdout.write('runner recovered\\n');",
  ].join('\n'));
  createProject({ id: 'project-runner-retry', name: 'Runner Retry', repoUrl: 'https://example.test/runner-retry', localPath: root });
  const state = { projectsCache: [{ id: 'project-runner-retry', name: 'Runner Retry', repoUrl: 'https://example.test/runner-retry', localPath: root }] } as any;
  const transitionRequests: any[] = [];
  const permitRequests: any[] = [];
  const result = await runBuiltinToolJob({
    toolName: 'run_project_command', state,
    args: { projectId: 'project-runner-retry', command: 'test', cacheResult: false, forceFresh: true, infrastructureRetryPolicy: 'resource-safe-once' },
  }, {
    logger: { stdout: () => {}, stderr: () => {} },
    setCancelFn: () => {},
    transitionAccess: async (mode: any, request: any) => {
      transitionRequests.push({ mode, request });
      return {
        runWithPermit: async (permitRequest: any, run: () => Promise<any>) => {
          permitRequests.push(permitRequest);
          return await run();
        },
        dispose: () => {},
      };
    },
  }) as any;

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '2');
  assert.equal(result.infrastructureRecovery?.retryCount, 1);
  assert.equal(transitionRequests.length, 1, 'direct recovery requests capacity only after proven infrastructure failure');
  assert.equal(transitionRequests[0].mode, 'verify');
  assert.equal(transitionRequests[0].request.sharedResources?.includes('verification-recovery'), true);
  assert.equal(permitRequests.length, 1);
});

test('apply_and_verify async runner fails closed before source mutation in verification-infra-blocked', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-composite-blocked-'));
  fs.writeFileSync(path.join(root, 'value.txt'), 'before\n', 'utf8');
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
    assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
    return result.stdout || '';
  };
  git(['init', '-b', 'develop']);
  git(['config', 'user.name', 'DevFlow Test']);
  git(['config', 'user.email', 'devflow@example.test']);
  git(['add', '.']);
  git(['commit', '-m', 'fixture']);

  const project = { id: 'project-runner-composite-blocked', name: 'Runner Composite Blocked', repoUrl: 'https://example.test/runner-composite-blocked', localPath: root };
  createProject(project);
  const now = new Date().toISOString();
  const task = {
    id: 'task-runner-composite-blocked', displayId: 'DVF-RUNNER-COMPOSITE', title: 'Composite guard fixture',
    description: 'Prove apply_and_verify cannot write while verification recovery is infra-blocked.', projectId: project.id,
    status: 'todo', priority: 'high', category: 'backend', tags: [], targetFiles: ['value.txt'],
    checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now,
  } as any;
  saveTask(task);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const claimed = claimTaskForSession(task.id, { sessionId: 'runner-composite-blocked-session', ownerKind: 'chat', ownerLabel: 'Composite blocked test' });
  const workspaceId = claimed.claim.workspaceId;

  try {
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: 'ctx-runner-composite-blocked',
      repoRevision: binding.session.repoRevision,
      contextPlanIdentity: 'plan-runner-composite-blocked',
    });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'implementing', reasonCode: 'fixture-mutation',
      evidence: { id: 'runner-composite-fixture-mutation', kind: 'owned-change', status: 'completed' },
    });
    const failedVerification = preflightHarnessExecutionGuard(state, 'run_project_command', {
      workspaceId, command: 'test-focused', harnessOperationId: 'runner-composite-oom',
    });
    recordHarnessExecutionOutcome(failedVerification, {
      ok: false, status: 'timed_out', timedOut: true, stderr: 'java.lang.OutOfMemoryError: Java heap space',
    });
    assert.equal(executionSessions.getActiveTaskExecutionSessionForWorkspace(workspaceId)?.lifecycle.stage, 'verification-infra-blocked');

    const before = fs.readFileSync(path.join(binding.workspace.root, 'value.txt'), 'utf8');
    await assert.rejects(
      runBuiltinToolJob({
        toolName: 'apply_and_verify', state,
        args: {
          projectId: project.id,
          workspaceId,
          files: [{ filePath: 'value.txt', edits: [{ type: 'replace', find: 'before', replaceWith: 'after' }] }],
          requestedCommands: ['test-focused'],
        },
      }, {
        logger: { stdout: () => {}, stderr: () => {} },
        setCancelFn: () => {},
        transitionAccess: () => {},
      }),
      (error: any) => error?.payload?.code === 'EXECUTION_LIFECYCLE_STAGE_BLOCKED',
    );
    assert.equal(fs.readFileSync(path.join(binding.workspace.root, 'value.txt'), 'utf8'), before, 'composite guard must fail before any source byte changes');
    assert.equal(git(['-C', binding.workspace.root, 'status', '--porcelain']).trim(), '', 'blocked composite must not leave staging or worktree drift');
  } finally {
    releaseTaskClaim(task.id, { sessionId: 'runner-composite-blocked-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('runner registry rejects unknown async tools explicitly', async () => {
  await assert.rejects(
    runBuiltinToolJob({ toolName: 'missing_tool', state: {} as any, args: {} }, {
      logger: { stdout: () => {}, stderr: () => {} },
      setCancelFn: () => {},
      transitionAccess: () => {},
    }),
    /No async runner implemented for tool: missing_tool/,
  );
});
