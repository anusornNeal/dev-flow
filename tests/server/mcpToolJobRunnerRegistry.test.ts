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
const { prepareProjectCommandVerificationCandidate } = await import('../../src/server/services/projectCommandService.js');
const blockerEvidence = await import('../../src/server/services/verificationBlockerEvidenceService.js');

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
  'continue_task_execution_tail',
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

test('apply_and_verify async runner treats verification-infra-blocked as recoverable debt instead of mutation authority', async () => {
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

    const result = await runBuiltinToolJob({
      toolName: 'apply_and_verify', state,
      args: {
        projectId: project.id,
        workspaceId,
        files: [{ filePath: 'value.txt', edits: [{ type: 'replace', find: 'before', replaceWith: 'after' }] }],
        requestedCommands: [],
      },
    }, {
      logger: { stdout: () => {}, stderr: () => {} },
      setCancelFn: () => {},
      transitionAccess: () => {},
    }) as any;
    assert.equal(result.ok, false, 'no verification command means quality is not GREEN, but stale stage is not mutation authority');
    assert.equal(fs.readFileSync(path.join(binding.workspace.root, 'value.txt'), 'utf8').trim(), 'after');
    assert.match(git(['-C', binding.workspace.root, 'status', '--porcelain']), /value\.txt/);
  } finally {
    git(['-C', executionSessions.getTaskExecutionMutationBinding({ workspaceId })?.workspace.root || root, 'checkout', '--', 'value.txt']);
    releaseTaskClaim(task.id, { sessionId: 'runner-composite-blocked-session', nextStatus: 'todo' });
    cleanupSessionWorkspace(workspaceId);
  }
});

test('run_project_command reuses a proven unrelated blocker across sibling task workspaces without spawning it twice', async () => {
  blockerEvidence.clearVerificationBlockerEvidence();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-known-blocker-'));
  const marker = path.join(os.tmpdir(), `devflow-runner-known-blocker-${path.basename(root)}.txt`);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'FeatureA.kt'), 'class FeatureA\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'FeatureB.kt'), 'class FeatureB\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'FakeUserRepository.kt'), 'class FakeUserRepository\n', 'utf8');  fs.writeFileSync(path.join(root, 'scripts', 'blocker.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    "const n = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(n), 'utf8');",
    "process.stderr.write('e: src/FakeUserRepository.kt:42:17 Unresolved reference verifyPassword\\nCompilation failed\\n');",
    "process.exit(1);",
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  blocker-check:',
    '    executable: node',
    '    args:',
    '      - scripts/blocker.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
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

  const project = { id: `project-known-blocker-${Date.now()}`, name: 'Known Blocker Fixture', repoUrl: `https://example.test/known-blocker-${Date.now()}`, localPath: root };
  createProject(project);
  const state = { projectsCache: [project], countersCache: {}, skillsRegistry: [] } as any;
  const now = new Date().toISOString();
  const taskA = { id: `${project.id}-a`, displayId: 'DVF-KNOWN-A', title: 'Known blocker A', description: 'Sibling A', projectId: project.id, status: 'todo', priority: 'medium', category: 'backend', tags: [], targetFiles: ['src/FeatureA.kt'], checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now } as any;
  const taskB = { id: `${project.id}-b`, displayId: 'DVF-KNOWN-B', title: 'Known blocker B', description: 'Sibling B', projectId: project.id, status: 'todo', priority: 'medium', category: 'backend', tags: [], targetFiles: ['src/FeatureB.kt'], checklist: [], logs: [], bugs: [], images: [], createdAt: now, updatedAt: now } as any;
  saveTask(taskA);
  saveTask(taskB);

  const runSibling = async (task: any, sessionId: string, ownedPath: string, batchId: string) => {
    const claimed = claimTaskForSession(task.id, { sessionId, ownerKind: 'chat', ownerLabel: sessionId });
    const workspaceId = claimed.claim.workspaceId;
    const binding = executionSessions.getTaskExecutionMutationBinding({ workspaceId })!;
    executionSessions.recordTaskExecutionContextReady({ workspaceId }, {
      contextHandle: `ctx-${sessionId}`,
      repoRevision: binding.session.repoRevision,
      contextPlanIdentity: `plan-${sessionId}`,
    });
    executionSessions.recordExecutionLifecycleTransition(binding.session.id, {
      toStage: 'implementing', reasonCode: 'fixture-mutation',
      evidence: { id: `mutation-${sessionId}`, kind: 'owned-change', status: 'completed' },
    });
    fs.appendFileSync(path.join(binding.workspace.root, ownedPath), `// ${sessionId}\n`, 'utf8');
    executionSessions.recordTaskExecutionMutationPaths({ workspaceId }, [ownedPath], 'fixture');
    const baseArgs = {
      projectId: project.id,
      workspaceId,
      command: 'blocker-check',
      cacheResult: false,
      forceFresh: true,
      verificationBatch: { id: batchId, requiredChecks: ['blocker-check'], checkId: 'blocker-check' },
    };
    const candidate = prepareProjectCommandVerificationCandidate(state, baseArgs)!;
    const result = await runBuiltinToolJob({ toolName: 'run_project_command', state, args: { ...baseArgs, __verificationCandidate: candidate } }, {
      logger: { stdout: () => {}, stderr: () => {} },
      setCancelFn: () => {},
      transitionAccess: () => {},
    }) as any;
    return { result, workspaceId, sessionId, binding };
  };

  const first = await runSibling(taskA, 'known-blocker-a', 'src/FeatureA.kt', 'known-blocker-batch-a');
  assert.equal(first.result.ok, false);
  assert.equal(first.result.verificationBlocker?.recorded, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '1');
  git(['-C', first.binding.workspace.root, 'checkout', '--', 'src/FeatureA.kt']);  releaseTaskClaim(taskA.id, { sessionId: first.sessionId, nextStatus: 'todo' });
  cleanupSessionWorkspace(first.workspaceId);

  const second = await runSibling(taskB, 'known-blocker-b', 'src/FeatureB.kt', 'known-blocker-batch-b');
  try {
    assert.equal(second.result.ok, false);
    assert.equal(second.result.verificationBlocker?.reused, true);
    assert.equal(fs.readFileSync(marker, 'utf8'), '1', 'the known blocked command must not spawn a second process');
    const batch = executionSessions.getExecutionVerificationBatchState(second.binding.session.id);
    assert.equal(batch?.status, 'blocked');
    assert.deepEqual(batch?.blocked, ['blocker-check']);
    assert.equal(batch?.canComplete, false);
    assert.deepEqual(executionSessions.getExecutionVerificationBatchLiveOperations(second.binding.session.id, 'known-blocker-batch-b'), []);
  } finally {
    git(['-C', second.binding.workspace.root, 'checkout', '--', 'src/FeatureB.kt']);    releaseTaskClaim(taskB.id, { sessionId: second.sessionId, nextStatus: 'todo' });
    cleanupSessionWorkspace(second.workspaceId);
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
