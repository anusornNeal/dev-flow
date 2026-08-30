// DVF-0685 regression coverage for commit-time reusable verification evidence.
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
  '  green-check:',
  '    executable: node',
  '    args:',
  '      - -e',
  "      - process.stdout.write('green-check')",
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
const { claimTaskForSession, releaseTaskClaim } = await import('../../src/server/services/taskClaimService.js');
const workspaceService = await import('../../src/server/services/sessionWorkspaceService.js');
const execution = await import('../../src/server/services/executionSessionService.js');
const commitPlan = await import('../../src/server/services/taskCommitPlanService.js');
const continuation = await import('../../src/server/services/executionContinuationService.js');
const { runBuiltinToolJob } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');
const jobService = await import('../../src/server/services/mcpToolJobService.js') as any;
const jobRepo = await import('../../src/server/repositories/mcpToolJobRepository.js') as any;
const checkpoints = await import('../../src/server/services/executionCheckpointService.js') as any;
const preparedEdits = await import('../../src/server/services/preparedEditService.js') as any;
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

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

test('commit-intent continuation reuses exact authoritative GREEN and admits exactly one tail without verification replay', async () => {
  const isolatedTaskId = `${taskId}-tail-intent`;
  saveTask({
    id: isolatedTaskId,
    displayId: 'DVF-OWNERSHIP-TAIL',
    title: 'Tail intent fixture',
    description: 'Prove missing commit intent continues from exact GREEN.',
    projectId,
    status: 'todo',
    priority: 'medium',
    category: 'backend',
    tags: ['tail-intent'],
    targetFiles: ['src/unrelated.ts'],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt: now,
    updatedAt: now,
  } as any);
  const isolatedOwner = 'ownership-tail-intent';
  const isolatedClaim = claimTaskForSession(isolatedTaskId, {
    sessionId: isolatedOwner,
    ownerKind: 'chat',
    ownerLabel: 'Tail intent test',
  });
  const isolatedWorkspace = workspaceService.resolveSessionWorkspace(isolatedClaim.claim.workspaceId)!;
  const isolatedSession = execution.getActiveTaskExecutionSessionForWorkspace(isolatedWorkspace.workspaceId)!;
  continuation.persistBoardLoopIntent(isolatedSession.id, {
    loopId: `loop-${isolatedSession.id}`,
    projectId,
    requestedTaskId: isolatedTaskId,
    status: 'active',
    startedAt: new Date().toISOString(),
  } as any);

  const verificationJobId = `job-green-${isolatedSession.id}`;
  jobRepo.createJob(verificationJobId, 'run_project_command', {
    projectId,
    workspaceId: isolatedWorkspace.workspaceId,
    command: 'green-check',
    __executionJobBinding: {
      operationId: verificationJobId,
      executionSessionId: isolatedSession.id,
      taskId: isolatedTaskId,
      workspaceId: isolatedWorkspace.workspaceId,
      projectId,
      toolName: 'run_project_command',
    },
  }, `workspace:${isolatedWorkspace.workspaceId}`, { eagerArtifacts: false });
  jobRepo.writeJobResult(verificationJobId, {
    ok: true,
    status: 'succeeded',
    verificationBinding: { authoritative: true },
  });
  jobRepo.transitionJobStatus(verificationJobId, ['queued'], { status: 'succeeded' });

  let tailRuns = 0;
  jobService.__setToolJobTestRunner('continue_task_execution_tail', async () => {
    tailRuns += 1;
    return { ok: true, status: 'completed' };
  });
  try {
    const verificationJobsBefore = jobRepo.listRecentJobs(200).filter((job: any) => (
      job.toolName === 'run_project_command'
      && job.args?.__executionJobBinding?.executionSessionId === isolatedSession.id
    ));
    assert.equal(verificationJobsBefore.length, 1);

    const first = jobService.continueAutonomousTailWithCommitIntent(state, {
      executionSessionId: isolatedSession.id,
      triggerJobId: verificationJobId,
      workspaceId: isolatedWorkspace.workspaceId,
      commitMessage: 'fix: continue exact green',
      completedChecklistIds: ['done'],
    });
    const second = jobService.continueAutonomousTailWithCommitIntent(state, {
      executionSessionId: isolatedSession.id,
      triggerJobId: verificationJobId,
      workspaceId: isolatedWorkspace.workspaceId,
      commitMessage: 'fix: continue exact green',
    });

    assert.equal(first.jobId, second.jobId, 'duplicate continuation must reuse the same durable tail');
    assert.equal(second.reused, true);
    assert.equal(first.verificationReplayed, false);
    assert.equal(first.verificationCandidateMaterialized, false);
    await waitUntil(() => jobService.getToolJobStatus(first.jobId)?.status === 'succeeded', 'Expected autonomous tail to finish');
    assert.equal(tailRuns, 1, 'exactly one autonomous tail runner should execute');

    const verificationJobsAfter = jobRepo.listRecentJobs(200).filter((job: any) => (
      job.toolName === 'run_project_command'
      && job.args?.__executionJobBinding?.executionSessionId === isolatedSession.id
    ));
    assert.equal(verificationJobsAfter.length, 1, 'commit-intent continuation must not enqueue duplicate verification');
    const tailJobs = jobRepo.listRecentJobs(200).filter((job: any) => (
      job.toolName === 'continue_task_execution_tail'
      && job.args?.triggerJobId === verificationJobId
    ));
    assert.equal(tailJobs.length, 1, 'duplicate continuation/reconnect must not duplicate tail effects');
    assert.deepEqual(tailJobs[0]?.args?.completedChecklistIds, ['done'], 'explicit checklist attestation must survive durable tail enqueue');
  } finally {
    jobService.__setToolJobTestRunner('continue_task_execution_tail', null);
    releaseTaskClaim(isolatedTaskId, { sessionId: isolatedOwner, nextStatus: 'todo' });
    workspaceService.cleanupSessionWorkspace(isolatedWorkspace.workspaceId);
  }
});

test('production enqueue binds queued lifecycle work to the admitted execution before returning', () => {
  const before = execution.getExecutionSessionState(session.id).session;
  const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
    projectId,
    workspaceId: workspace.workspaceId,
    mode: 'apply',
    files: [{ filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] }],
    singleFlight: false,
  }, 'repo-command');

  const persisted = jobRepo.getJob(job.jobId);
  assert.equal(persisted?.status, 'queued');
  assert.deepEqual(persisted?.args?.__executionJobBinding, {
    operationId: job.jobId,
    executionSessionId: session.id,
    taskId,
    workspaceId: workspace.workspaceId,
    projectId,
    toolName: 'edit_local_files_batch',
  });
  const accepted = checkpoints.getLatestExecutionCheckpoint(session.id);
  assert.equal(accepted?.pendingOperations.length, 1);
  assert.equal(accepted?.pendingOperations[0]?.operationId, job.jobId);
  assert.equal(accepted?.pendingOperations[0]?.status, 'accepted');
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, before.lifecycle.stage);
  assert.deepEqual(execution.getExecutionSessionState(session.id).session.changedFiles, before.changedFiles);
  assert.deepEqual(execution.getExecutionSessionState(session.id).session.verification, before.verification);

  jobRepo.clearRecentJobCache();
  assert.equal(jobRepo.getJob(job.jobId)?.args?.__executionJobBinding?.executionSessionId, session.id);
  assert.equal(jobService.cancelToolJob(job.jobId), true);
  assert.equal(jobRepo.getJob(job.jobId)?.status, 'cancelled');
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId), false);
});

test('running refresh is idempotent and active cancellation stays pending until worker exit', async () => {
  const blocker = deferred();
  jobService.__setToolJobTestRunner('edit_local_files_batch', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    setCancelFn(() => blocker.resolve());
    await blocker.promise;
    return { ok: true, status: 'succeeded' };
  });

  const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
    projectId,
    workspaceId: workspace.workspaceId,
    mode: 'apply',
    files: [{ filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] }],
    singleFlight: false,
  }, 'repo-command');
  try {
    await waitUntil(() => jobRepo.getJob(job.jobId)?.status === 'running', 'Expected task-bound durable job to enter running');
    const running = checkpoints.getLatestExecutionCheckpoint(session.id);
    assert.deepEqual(running?.pendingOperations.filter((entry: any) => entry.operationId === job.jobId).map((entry: any) => entry.status), ['running']);

    assert.equal(jobService.cancelToolJob(job.jobId), true);
    assert.equal(jobRepo.getJob(job.jobId)?.status, 'cancelled');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId), true);

    blocker.resolve();
    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === job.jobId), 'Expected cancelled task-bound worker to exit');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId), false);
    assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'context-ready');
  } finally {
    blocker.resolve();
    jobService.__setToolJobTestRunner('edit_local_files_batch', null);
  }
});

test('prepared-edit admission resolves and persists source execution binding from editPlanId', () => {
  const plan = preparedEdits.prepareEditPlan(state, {
    projectId,
    workspaceId: workspace.workspaceId,
    files: [{ filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] }],
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.editPlanId);

  const job = jobService.enqueueToolJob(state, 'apply_prepared_edit', { editPlanId: plan.editPlanId }, 'repo-command');
  const persisted = jobRepo.getJob(job.jobId);
  assert.equal(persisted?.status, 'queued');
  assert.equal(persisted?.resourceKey, `workspace:${workspace.workspaceId}`);
  assert.equal(persisted?.args?.__preparedEditSourceArgs?.workspaceId, workspace.workspaceId);
  assert.equal(persisted?.args?.__executionJobBinding?.executionSessionId, session.id);
  assert.equal(persisted?.args?.__executionJobBinding?.operationId, job.jobId);
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId && entry.status === 'accepted'), true);

  assert.equal(jobService.cancelToolJob(job.jobId), true);
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId), false);
});

test('captured durable binding cannot transfer authority to a different active execution id', () => {
  assert.throws(
    () => execution.getTaskExecutionMutationBinding({
      workspaceId: workspace.workspaceId,
      __executionJobBinding: {
        operationId: 'job-old-execution',
        executionSessionId: 'exec-obsolete',
        taskId,
        workspaceId: workspace.workspaceId,
        projectId,
      },
    }),
    (error: any) => error?.payload?.code === 'TASK_MUTATION_EXECUTION_FENCED',
  );
});

test('restart-like scheduler memory loss reconstructs the same accepted blocker from durable job binding', () => {
  const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
    projectId,
    workspaceId: workspace.workspaceId,
    mode: 'apply',
    files: [{ filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] }],
    singleFlight: false,
  }, 'repo-command');
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId && entry.status === 'accepted'), true);

  jobService.__resetMcpToolJobRuntimeForTests();
  jobRepo.clearRecentJobCache();
  const recovered = jobService.__runDurableJobRecoveryPassForTests(state);
  assert.equal(recovered.resumable, 1);
  assert.equal(jobRepo.getJob(job.jobId)?.args?.__executionJobBinding?.executionSessionId, session.id);
  assert.deepEqual(
    checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.filter((entry: any) => entry.operationId === job.jobId).map((entry: any) => entry.status),
    ['accepted'],
  );

  assert.equal(jobService.cancelToolJob(job.jobId), true);
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId), false);
});

test('non-lifecycle read jobs never create execution pending authority even with workspace context', () => {
  const before = checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.map((entry: any) => entry.operationId) || [];
  const job = jobService.enqueueToolJob(state, 'search_local_files', {
    projectId,
    workspaceId: workspace.workspaceId,
    query: 'owned',
    singleFlight: false,
  }, 'repo-read');
  assert.equal(jobRepo.getJob(job.jobId)?.args?.__executionJobBinding, undefined);
  assert.deepEqual(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.map((entry: any) => entry.operationId) || [], before);
  jobService.cancelToolJob(job.jobId);
});

test('success failure and timeout terminal states reconcile only their durable pending operation', async () => {
  const cases = [
    { label: 'success', expected: 'succeeded', run: async () => ({ ok: true, status: 'succeeded' }) },
    { label: 'failure', expected: 'failed', run: async () => { throw new Error('expected durable failure'); } },
    { label: 'timeout', expected: 'timed_out', run: async () => ({ ok: false, timedOut: true, status: 'timed_out' }) },
  ];

  for (const item of cases) {
    jobService.__setToolJobTestRunner('edit_local_files_batch', item.run);
    try {
      const job = jobService.enqueueToolJob(state, 'edit_local_files_batch', {
        projectId,
        workspaceId: workspace.workspaceId,
        mode: 'apply',
        files: [{ filePath: 'src/owned.ts', edits: [{ type: 'replace', find: 'owned = 1', replaceWith: 'owned = 2' }] }],
        label: item.label,
        singleFlight: false,
      }, 'repo-command');
      await waitUntil(() => jobRepo.getJob(job.jobId)?.status === item.expected, `Expected ${item.label} durable job to become ${item.expected}`);
      await waitUntil(
        () => !checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === job.jobId),
        `Expected ${item.label} durable pending operation to reconcile`,
      );
      assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'context-ready');
    } finally {
      jobService.__setToolJobTestRunner('edit_local_files_batch', null);
    }
  }
});

test('single-flight follower creates no independent pending authority and follower cancel leaves leader blocker intact', async () => {
  const blocker = deferred();
  let starts = 0;
  jobService.__setToolJobTestRunner('run_project_command', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    starts += 1;
    setCancelFn(() => blocker.resolve());
    await blocker.promise;
    return { ok: true, status: 'succeeded' };
  });

  try {
    const args = {
      projectId,
      workspaceId: workspace.workspaceId,
      command: 'test',
      singleFlight: true,
      verificationSeriesKey: `ownership-single-flight-${Date.now()}`,
      verificationCandidateKey: 'leader',
    };
    const leader = jobService.enqueueToolJob(state, 'run_project_command', args, 'repo-command');
    const follower = jobService.enqueueToolJob(state, 'run_project_command', args, 'repo-command');
    assert.equal(follower.sharedWith, leader.jobId);
    assert.equal(jobRepo.getJob(follower.jobId)?.args?.__executionJobBinding, undefined);
    assert.deepEqual(
      checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.map((entry: any) => entry.operationId),
      [leader.jobId],
    );

    await waitUntil(() => starts === 1, 'Expected only single-flight leader to execute');
    assert.equal(jobService.cancelToolJob(follower.jobId), true);
    assert.equal(jobRepo.getJob(follower.jobId)?.status, 'cancelled');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === leader.jobId), true);

    blocker.resolve();
    await waitUntil(() => jobRepo.getJob(leader.jobId)?.status === 'succeeded', 'Expected single-flight leader to succeed');
    await waitUntil(() => !checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === leader.jobId), 'Expected leader pending operation to reconcile');
  } finally {
    blocker.resolve();
    jobService.__setToolJobTestRunner('run_project_command', null);
  }
});

test('active verification supersession keeps old operation pending until old worker exits and never clears replacement', async () => {
  const gateA = deferred();
  const gateB = deferred();
  const starts: string[] = [];
  jobService.__setToolJobTestRunner('run_project_command', async (_state: any, args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    starts.push(args.verificationCandidateKey);
    if (args.verificationCandidateKey === 'A') {
      setCancelFn(() => gateA.resolve());
      await gateA.promise;
    } else {
      setCancelFn(() => gateB.resolve());
      await gateB.promise;
    }
    return { ok: true, status: 'succeeded', candidate: args.verificationCandidateKey };
  });

  try {
    const series = `ownership-supersession-${Date.now()}`;
    const baseArgs = {
      projectId,
      workspaceId: workspace.workspaceId,
      command: 'test',
      singleFlight: false,
      verificationSeriesKey: series,
      verificationEvidenceIntent: 'green',
    };
    const oldJob = jobService.enqueueToolJob(state, 'run_project_command', { ...baseArgs, verificationCandidateKey: 'A' }, 'repo-command');
    await waitUntil(() => starts.includes('A'), 'Expected old verification candidate to start');
    const replacement = jobService.enqueueToolJob(state, 'run_project_command', { ...baseArgs, verificationCandidateKey: 'B' }, 'repo-command');

    assert.equal(jobRepo.getJob(oldJob.jobId)?.status, 'cancelled');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === oldJob.jobId), true);
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === replacement.jobId), true);

    await waitUntil(() => !jobService.getJobMetrics().activeJobs.some((entry: any) => entry.jobId === oldJob.jobId), 'Expected superseded old worker to exit');
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === oldJob.jobId), false);
    assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === replacement.jobId), true);

    gateB.resolve();
    await waitUntil(() => jobRepo.getJob(replacement.jobId)?.status === 'succeeded', 'Expected replacement verification to succeed');
    await waitUntil(() => !checkpoints.getLatestExecutionCheckpoint(session.id)?.pendingOperations.some((entry: any) => entry.operationId === replacement.jobId), 'Expected replacement pending operation to reconcile');
  } finally {
    gateA.resolve();
    gateB.resolve();
    jobService.__setToolJobTestRunner('run_project_command', null);
  }
});

test('verification batch replacement waits for live durable members and late old results stay non-authoritative', async () => {
  const captured = execution.captureExecutionVerificationProvenance(session.id, { repoRoot: workspace.root });
  const oldBatchId = `ownership-old-batch-${Date.now()}`;
  const replacementBatchId = `${oldBatchId}-replacement`;
  const oldRequiredChecks = ['focused', 'green-check'];
  const first = execution.recordExecutionVerificationBatchResult(session.id, {
    repoRoot: workspace.root,
    batchId: oldBatchId,
    requiredChecks: oldRequiredChecks,
    checkId: 'focused',
    status: 'passed',
    captured,
    memberCandidate: { candidateId: `${oldBatchId}-focused`, repoRevision: captured.repoRevision, executionKey: `${oldBatchId}-focused-key` },
  });
  assert.equal(first.state.status, 'pending');

  const gate = deferred();
  let started = false;
  jobService.__setToolJobTestRunner('run_project_command', async (_state: any, _args: any, _logger: any, setCancelFn: (fn: () => void) => void) => {
    started = true;
    setCancelFn(() => gate.resolve());
    await gate.promise;
    return { ok: true, status: 'succeeded' };
  });

  const supersessionReason = 'Replace an abandoned sequential batch only after its final durable member worker is fenced and terminal.';
  const replacementInput = {
    repoRoot: workspace.root,
    batchId: replacementBatchId,
    requiredChecks: ['replacement'],
    checkId: 'replacement',
    status: 'passed' as const,
    captured,
    memberCandidate: { candidateId: `${replacementBatchId}-candidate`, repoRevision: captured.repoRevision, executionKey: `${replacementBatchId}-key` },
    supersedesBatchId: oldBatchId,
    supersessionReason,
  };

  try {
    const liveArgs = verificationArgs('green-check');
    liveArgs.verificationBatch = { id: oldBatchId, requiredChecks: oldRequiredChecks, checkId: 'green-check' };
    const liveJob = jobService.enqueueToolJob(state, 'run_project_command', liveArgs, 'repo-command');
    await waitUntil(() => started, 'Expected old verification batch member to start');
    assert.equal(execution.getExecutionVerificationBatchLiveOperations(session.id, oldBatchId).some((entry: any) => entry.operationId === liveJob.jobId), true);

    assert.throws(
      () => execution.recordExecutionVerificationBatchResult(session.id, replacementInput),
      (error: any) => error?.code === 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS',
    );

    assert.equal(jobService.cancelToolJob(liveJob.jobId), true);
    assert.equal(jobRepo.getJob(liveJob.jobId)?.status, 'cancelled');
    assert.equal(execution.getExecutionVerificationBatchLiveOperations(session.id, oldBatchId).some((entry: any) => entry.operationId === liveJob.jobId), true);
    assert.throws(
      () => execution.recordExecutionVerificationBatchResult(session.id, replacementInput),
      (error: any) => error?.code === 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS',
    );

    gate.resolve();
    await waitUntil(() => execution.getExecutionVerificationBatchLiveOperations(session.id, oldBatchId).length === 0, 'Expected cancelled old batch member to leave the durable execution fence');

    const replacement = execution.recordExecutionVerificationBatchResult(session.id, replacementInput);
    assert.equal(replacement.authoritative, true);
    assert.equal(replacement.state.batchId, replacementBatchId);
    assert.equal(execution.getExecutionVerificationBatchStateById(session.id, oldBatchId)?.status, 'superseded');
    assert.equal(execution.getExecutionVerificationBatchStateById(session.id, oldBatchId)?.supersededByBatchId, replacementBatchId);

    const replay = execution.recordExecutionVerificationBatchResult(session.id, replacementInput);
    assert.equal(replay.idempotent, true);
    assert.equal(replay.authoritative, true);

    const lateOldResult = execution.recordExecutionVerificationBatchResult(session.id, {
      repoRoot: workspace.root,
      batchId: oldBatchId,
      requiredChecks: oldRequiredChecks,
      checkId: 'green-check',
      status: 'passed',
      captured,
      memberCandidate: { candidateId: `${oldBatchId}-late`, repoRevision: captured.repoRevision, executionKey: `${oldBatchId}-late-key` },
    });
    assert.equal(lateOldResult.authoritative, false);
    assert.equal(lateOldResult.reasonCode, 'EXECUTION_VERIFICATION_BATCH_SUPERSEDED');
    assert.equal(execution.getExecutionVerificationBatchState(session.id)?.batchId, replacementBatchId);
    assert.equal(execution.getExecutionVerificationBatchState(session.id)?.status, 'complete');
    assert.equal(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);
  } finally {
    gate.resolve();
    jobService.__setToolJobTestRunner('run_project_command', null);
  }
});

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

test('task-bound sequential MCP verification stays pending after the first check and becomes authoritative only after the final check', async () => {
  const batchId = `ownership-sequential-${Date.now()}`;
  const requiredChecks = ['test', 'green-check'];
  const firstArgs = verificationArgs('test');
  firstArgs.verificationBatch = { id: batchId, requiredChecks, checkId: 'test' };
  const first = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: firstArgs,
  }, context as any) as any;

  assert.equal(first.ok, true);
  assert.equal(first.status, 'succeeded');
  assert.equal(first.verificationBinding?.authoritative, false);
  assert.equal(first.verificationBinding?.reasonCode, 'EXECUTION_VERIFICATION_BATCH_INCOMPLETE');
  assert.equal(first.verificationBinding?.recoveryRequired, false);
  assert.notEqual(execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root }).verificationFresh, true);
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'repairing');
  let plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.blockers.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_LIVE_MEMBERS'), false);
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_BATCH_PENDING'));

  const secondArgs = verificationArgs('green-check');
  secondArgs.verificationBatch = { id: batchId, requiredChecks, checkId: 'green-check' };
  const second = await runBuiltinToolJob({
    toolName: 'run_project_command',
    state,
    args: secondArgs,
  }, context as any) as any;

  assert.equal(second.ok, true);
  assert.equal(second.status, 'succeeded');
  assert.equal(second.verificationBinding?.authoritative, true);
  assert.equal(second.verificationBinding?.verificationFresh, true);

  const ownership = execution.getExecutionOwnershipState(session.id, { repoRoot: workspace.root });
  assert.deepEqual(ownership.ownedChanges, ['src/owned.ts']);
  assert.deepEqual(ownership.unrelatedChanges, ['src/unrelated.ts']);
  assert.equal(ownership.verificationFresh, true);
  assert.equal(execution.getExecutionSessionState(session.id).session.lifecycle.stage, 'verifying');

  plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.deepEqual(plan.ownedChangedFiles, ['src/owned.ts']);
  assert.deepEqual(plan.unrelatedChangedFiles, ['src/unrelated.ts']);
  assert.equal(plan.verificationFresh, true);
});

test('verification coverage survives an unrelated workspace mutation', () => {
  fs.writeFileSync(path.join(workspace.root, 'src', 'unrelated.ts'), 'export const unrelated = 4;\n');

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationState, 'authoritative-fresh');
  assert.equal(plan.verificationCoverage.status, 'covered');
});

test('verification coverage becomes stale when a dependency input changes', () => {
  fs.writeFileSync(path.join(workspace.root, 'package.json'), JSON.stringify({
    name: 'execution-ownership-fixture',
    private: true,
    version: '1.0.1',
    scripts: { test: 'node -e "process.stdout.write(\'green\')"' },
  }, null, 2));

  const plan = commitPlan.buildTaskCommitPlan(state, { taskId, workspaceId: workspace.workspaceId });
  assert.equal(plan.commitAllowed, true);
  assert.equal(plan.verificationState, 'stale');
  assert.equal(plan.verificationCoverage.status, 'stale');
  assert.ok(plan.verificationCoverage.staleCommands.includes('green-check'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_COVERAGE_STALE'));
  assert.ok(plan.debts.some((entry: any) => entry.code === 'EXECUTION_VERIFICATION_NOT_FRESH'));
});
