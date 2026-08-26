import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-continuation-finalize-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSession } = await import('../../src/server/services/executionSessionService.js');
const { updateExecutionSessionRecord } = await import('../../src/server/repositories/executionSessionRepository.js');
const {
  createTaskFinalizationOperation,
  updateTaskFinalizationOperation,
} = await import('../../src/server/repositories/taskFinalizationOperationRepository.js');
const { evaluateExecutionContinuation } = await import('../../src/server/services/executionContinuationService.js');
const { getWorkflowRecoveryHandoff } = await import('../../src/server/services/workflowRecoveryHandoffService.js');

const project = {
  id: 'project-cont-finalize',
  name: 'Continuation Finalization Fixture',
  repoUrl: 'https://example.test/continuation-finalize',
  localPath: null,
};
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };
const now = new Date().toISOString();
const task = {
  id: 'task-cont-finalize',
  displayId: 'DVF-CONT-FINALIZE',
  title: 'Continuation finalization fixture',
  description: 'fixture',
  projectId: project.id,
  status: 'in-progress',
  priority: 'medium',
  branch: 'develop',
  category: 'backend',
  tags: [],
  targetFiles: ['src/example.ts'],
  checklist: [{ id: 'impl', text: 'Implemented', completed: true }],
  logs: [], bugs: [], images: [], designImages: [],
  createdAt: now,
  updatedAt: now,
} as any;
saveTask(task);
const execution = createExecutionSession({ projectId: project.id, taskId: task.id, branch: 'develop' });
const operation = createTaskFinalizationOperation({
  id: 'finalize-continuation-test',
  projectId: project.id,
  taskId: task.id,
  workspaceId: 'ws-finalization-fixture',
  executionSessionId: execution.id,
  ownershipEpochId: 'epoch-fixture',
  sourceHead: 'a'.repeat(40),
  baseRevision: 'b'.repeat(40),
  baseBranch: 'develop',
  candidateId: 'candidate-fixture',
  candidateRepoRevision: 'candidate-revision',
  ownedFingerprint: 'owned-fixture',
  phase: 'frozen',
  status: 'active',
  createdAt: now,
  updatedAt: now,
});

const nonTerminalPhases = [
  'frozen',
  'integrated',
  'verification-pending',
  'verification-cleared',
  'evidence-recorded',
  'execution-terminalized',
  'task-projected',
] as const;

for (const phase of nonTerminalPhases) {
  test(`finalization phase ${phase} remains continuation-required with the same operation id`, () => {
    updateTaskFinalizationOperation(operation.id, { phase, status: 'active', updatedAt: new Date().toISOString() });
    const result = evaluateExecutionContinuation(state, execution.id);
    assert.equal(result.terminal, false);
    assert.equal(result.continuationRequired, true);
    assert.equal(result.nextAction?.action, 'retry-finalization');
    assert.equal(result.nextAction && 'operationId' in result.nextAction ? result.nextAction.operationId : null, operation.id);
    assert.equal(result.nextAction && 'reintegrate' in result.nextAction ? result.nextAction.reintegrate : null, false);
    assert.ok(result.reasonCodes.includes(`FINALIZATION_PHASE_${phase.toUpperCase().replace(/-/g, '_')}`));
  });
}

test('cleanup-pending remains non-terminal and uses the same resumable finalization operation', () => {
  updateTaskFinalizationOperation(operation.id, {
    phase: 'cleanup-pending',
    status: 'cleanup-pending',
    updatedAt: new Date().toISOString(),
  });
  const result = evaluateExecutionContinuation(state, execution.id);
  assert.equal(result.terminal, false);
  assert.equal(result.continuationRequired, true);
  assert.ok(result.reasonCodes.includes('FINALIZATION_CLEANUP_PENDING'));
  assert.equal(result.nextAction?.action, 'retry-finalization');
});

test('recovery handoff carries the same continuation truth for a paused finalization operation', () => {
  updateTaskFinalizationOperation(operation.id, {
    phase: 'verification-pending',
    status: 'active',
    updatedAt: new Date().toISOString(),
  });
  const direct = evaluateExecutionContinuation(state, execution.id);
  const recovery = getWorkflowRecoveryHandoff(state, { taskId: task.displayId }) as any;
  assert.ok(recovery.executionContinuation);
  assert.equal(recovery.executionContinuation.terminal, direct.terminal);
  assert.deepEqual(recovery.executionContinuation.reasonCodes, direct.reasonCodes);
  assert.deepEqual(recovery.executionContinuation.nextAction, direct.nextAction);
});

test('completed finalization plus terminal task and execution is genuinely terminal', () => {
  const completedAt = new Date().toISOString();
  updateTaskFinalizationOperation(operation.id, {
    phase: 'completed',
    status: 'completed',
    completedAt,
    updatedAt: completedAt,
  });
  saveTask({ ...task, status: 'done', updatedAt: completedAt });
  updateExecutionSessionRecord(execution.id, { status: 'completed', endedAt: completedAt, updatedAt: completedAt });
  const result = evaluateExecutionContinuation(state, execution.id);
  assert.equal(result.terminal, true);
  assert.equal(result.continuationRequired, false);
  assert.equal(result.nextAction, null);
});

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
