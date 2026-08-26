import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-continuation-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask, getTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSession, recordExecutionLifecycleTransition } = await import('../../src/server/services/executionSessionService.js');
const { updateExecutionSessionRecord, saveExecutionSessionEvidence } = await import('../../src/server/repositories/executionSessionRepository.js');
const { recordExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');
const { createJob } = await import('../../src/server/repositories/mcpToolJobRepository.js');
const { evaluateExecutionContinuation } = await import('../../src/server/services/executionContinuationService.js');

const project = {
  id: 'project-continuation',
  name: 'Continuation Fixture',
  repoUrl: 'https://example.test/continuation',
  localPath: null,
};
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };
let sequence = 0;

function fixture(options: { checklistComplete?: boolean; taskStatus?: string; workspaceId?: string | null } = {}) {
  sequence += 1;
  const now = new Date().toISOString();
  const task = {
    id: `task-cont-${sequence}`,
    displayId: `DVF-CONT-${sequence}`,
    title: `Continuation ${sequence}`,
    description: 'fixture',
    projectId: project.id,
    status: options.taskStatus || 'in-progress',
    priority: 'medium',
    branch: 'develop',
    category: 'backend',
    tags: [],
    targetFiles: ['src/example.ts'],
    checklist: [{ id: 'impl', text: 'Finish implementation', completed: options.checklistComplete === true }],
    logs: [],
    bugs: [],
    images: [],
    designImages: [],
    createdAt: now,
    updatedAt: now,
  } as any;
  saveTask(task);
  const session = createExecutionSession({
    projectId: project.id,
    taskId: task.id,
    workspaceId: options.workspaceId === undefined ? null : options.workspaceId,
    branch: 'develop',
  });
  return { task: getTask(task.id)!, session };
}

function advance(sessionId: string, toStage: any, suffix: string) {
  return recordExecutionLifecycleTransition(sessionId, {
    toStage,
    reasonCode: `test-${suffix}`,
    evidence: { id: `evidence-${sessionId}-${suffix}`, kind: 'test', status: 'completed' },
  });
}

function advanceTo(sessionId: string, target: 'implementing' | 'verifying' | 'committed' | 'finalized') {
  advance(sessionId, 'context-ready', 'context');
  advance(sessionId, 'implementing', 'implementing');
  if (target === 'implementing') return;
  advance(sessionId, 'verifying', 'verifying');
  if (target === 'verifying') return;
  advance(sessionId, 'committed', 'committed');
  if (target === 'committed') return;
  advance(sessionId, 'finalized', 'finalized');
}

test('incomplete checklist remains continuation-required during verification', () => {
  const { session } = fixture();
  advanceTo(session.id, 'verifying');
  const result = evaluateExecutionContinuation(state, session.id);
  assert.equal(result.terminal, false);
  assert.equal(result.continuationRequired, true);
  assert.equal(result.nextAction, null);
  assert.ok(result.reasonCodes.includes('TASK_CHECKLIST_INCOMPLETE'));
  assert.ok(result.reasonCodes.includes('VERIFICATION_IS_NON_TERMINAL'));
});

test('a clean committed milestone is still non-terminal and points to finalization when workspace identity exists', () => {
  const { session } = fixture({ checklistComplete: true, workspaceId: 'ws-missing-for-test' });
  advanceTo(session.id, 'committed');
  const result = evaluateExecutionContinuation(state, session.id);
  assert.equal(result.terminal, false);
  assert.equal(result.continuationRequired, true);
  assert.equal(result.blocked, true);
  assert.ok(result.reasonCodes.includes('EXECUTION_WORKSPACE_REVALIDATION_REQUIRED'));
  assert.equal(result.nextAction?.action, 'recover-execution');
});

test('accepted durable operation returns exact query continuation and never duplicate-launch guidance', () => {
  const { task, session } = fixture();
  const jobId = `job-cont-${sequence}`;
  createJob(jobId, 'run_project_command', {
    projectId: project.id,
    taskId: task.id,
    __executionJobBinding: {
      operationId: jobId,
      executionSessionId: session.id,
      taskId: task.id,
      workspaceId: '',
      projectId: project.id,
      toolName: 'run_project_command',
    },
  }, `continuation:${jobId}`, { eagerArtifacts: false });
  recordExecutionPendingOperationReference(session.id, {
    operationId: jobId,
    evidenceId: `accepted-${jobId}`,
    kind: 'project-command',
    status: 'accepted',
  });

  const result = evaluateExecutionContinuation(state, session.id);
  assert.equal(result.terminal, false);
  assert.equal(result.blocked, false);
  assert.equal(result.nextAction?.action, 'query-pending-jobs');
  assert.deepEqual(result.nextAction && 'jobIds' in result.nextAction ? result.nextAction.jobIds : [], [jobId]);
  assert.equal(result.nextAction && 'replay' in result.nextAction ? result.nextAction.replay : null, false);
  assert.deepEqual(result.pendingOperations.map((entry) => entry.operationId), [jobId]);
});

test('stale execution evidence is a bounded recovery blocker, not successful completion', () => {
  const { session } = fixture();
  const now = new Date().toISOString();
  saveExecutionSessionEvidence({
    id: `stale-${session.id}`,
    sessionId: session.id,
    kind: 'file',
    path: 'src/example.ts',
    repoRevision: 'old-revision',
    fileRevision: 'old-file',
    revisionIdentity: 'old',
    contextHandle: null,
    stale: true,
    metadata: {},
    createdAt: now,
    updatedAt: now,
  });
  const result = evaluateExecutionContinuation(state, session.id);
  assert.equal(result.terminal, false);
  assert.equal(result.blocked, true);
  assert.ok(result.reasonCodes.includes('EXECUTION_EVIDENCE_REVALIDATION_REQUIRED'));
  assert.equal(result.nextAction?.action, 'recover-execution');
  assert.equal(result.nextAction && 'replacementExecutionAllowed' in result.nextAction ? result.nextAction.replacementExecutionAllowed : null, false);
});

test('historical completed execution stays readable and is terminal without new continuation evidence', () => {
  const { task, session } = fixture({ checklistComplete: true, taskStatus: 'done' });
  const now = new Date().toISOString();
  updateExecutionSessionRecord(session.id, { status: 'completed', endedAt: now, updatedAt: now });
  const result = evaluateExecutionContinuation(state, session.id);
  assert.equal(result.terminal, true);
  assert.equal(result.continuationRequired, false);
  assert.equal(result.blocked, false);
  assert.deepEqual(result.reasonCodes, ['EXECUTION_SCOPE_TERMINAL']);
  assert.equal(result.nextAction, null);
  assert.equal(result.task?.id, task.id);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
