import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-board-live-work-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { deriveTaskBoardLiveWorkProjection } = await import('../../src/server/services/taskBoardLiveWorkProjectionService.js');

const now = new Date('2026-08-26T01:00:00.000Z');

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-live',
    displayId: 'DVF-LIVE',
    title: 'Live work fixture',
    description: 'fixture',
    projectId: 'project-live',
    status: 'in-progress',
    priority: 'medium',
    tags: [],
    logs: [],
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:59:00.000Z',
    claim: {
      sessionIdHash: 'abcd',
      ownershipEpochId: 'epoch-1',
      workspaceId: 'ws-live',
      ownerKind: 'chat',
      ownerLabel: 'Chat A1',
      claimedAt: '2026-08-26T00:30:00.000Z',
      expiresAt: '2026-08-27T00:30:00.000Z',
    },
    ...overrides,
  } as any;
}

function execution(stage: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'exec-live',
    projectId: 'project-live',
    taskId: 'task-live',
    workspaceId: 'ws-live',
    branch: '0323',
    baseRevision: null,
    repoRevision: 'abc123',
    status: 'active',
    lifecycle: { stage, legacyCompatibility: false, lastTransition: null },
    contextHandle: null,
    changedFiles: [],
    verification: [],
    createdAt: '2026-08-26T00:30:00.000Z',
    updatedAt: '2026-08-26T00:58:00.000Z',
    expiresAt: null,
    endedAt: null,
    ...overrides,
  } as any;
}

function checkpoint(overrides: Record<string, unknown> = {}) {
  return {
    id: 'checkpoint-live',
    executionSessionId: 'exec-live',
    updatedAt: '2026-08-26T00:59:30.000Z',
    stage: 'implementing',
    transitionEvidenceId: null,
    reasonCode: null,
    sourceRepoRevision: 'abc123',
    contextHandle: null,
    contextHandleLineage: [],
    changedFiles: [],
    verificationReferences: [],
    pendingOperations: [],
    completedWork: [],
    pendingNextWork: [],
    decisions: [],
    blockers: [],
    ...overrides,
  } as any;
}

test('projects managed lifecycle stages into stable board phases', () => {
  assert.equal(deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('context-ready')] })?.phase, 'inspecting');
  assert.equal(deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('implementing')] })?.phase, 'editing');
  assert.equal(deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('verifying')] })?.phase, 'verifying');
  assert.equal(deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('committed')] })?.phase, 'integrating');
  assert.equal(deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('finalized')] })?.phase, 'finalizing');
});

test('authoritative pending operation can advance the visible phase without inventing activity', () => {
  const result = deriveTaskBoardLiveWorkProjection(task(), {
    now,
    activeExecutions: [execution('verifying')],
    checkpoint: checkpoint({
      pendingOperations: [{ operationId: 'op-1', evidenceId: 'ev-1', kind: 'commit_task_owned_changes', status: 'running', observedAt: now.toISOString() }],
    }),
  });
  assert.equal(result?.phase, 'committing');
  assert.equal(result?.phaseLabel, 'Committing');
  assert.equal(result?.activity, 'Commit task owned changes');
});

test('checkpoint blockers and infra-blocked lifecycle render as blocked', () => {
  const checkpointBlocked = deriveTaskBoardLiveWorkProjection(task(), {
    now,
    activeExecutions: [execution('implementing')],
    checkpoint: checkpoint({ blockers: ['Waiting for lifecycle recovery'] }),
  });
  assert.equal(checkpointBlocked?.phase, 'blocked');
  assert.equal(checkpointBlocked?.activity, 'Waiting for lifecycle recovery');

  const infraBlocked = deriveTaskBoardLiveWorkProjection(task(), {
    now,
    activeExecutions: [execution('verification-infra-blocked')],
  });
  assert.equal(infraBlocked?.phase, 'blocked');
});

test('expired claims, terminal executions, ready-for-review and done tasks do not claim managed live work', () => {
  const expired = task({ claim: { ...task().claim, expiresAt: '2026-08-25T00:00:00.000Z' } });
  assert.equal(deriveTaskBoardLiveWorkProjection(expired, { now, activeExecutions: [execution('implementing')] }), null);

  assert.equal(deriveTaskBoardLiveWorkProjection(task(), {
    now,
    activeExecutions: [execution('finalized', { status: 'completed', endedAt: now.toISOString() })],
  }), null);
  assert.equal(deriveTaskBoardLiveWorkProjection(task({ status: 'ready-for-review' }), { now, activeExecutions: [execution('verifying')] }), null);
  assert.equal(deriveTaskBoardLiveWorkProjection(task({ status: 'done' }), { now, activeExecutions: [execution('finalized')] }), null);
});

test('external agent run is the fallback only when managed live work is absent', () => {
  const withoutClaim = task({
    claim: undefined,
    activeAgent: 'Codex',
    latestAgentRun: {
      id: 'run-1',
      status: 'running',
      agent: 'Codex',
      createdAt: '2026-08-26T00:40:00.000Z',
      startedAt: '2026-08-26T00:41:00.000Z',
    },
  });
  const result = deriveTaskBoardLiveWorkProjection(withoutClaim, { now });
  assert.equal(result?.source, 'agent');
  assert.equal(result?.ownerLabel, 'Codex');
  assert.equal(result?.phase, 'working');

  const managed = deriveTaskBoardLiveWorkProjection(task({ activeAgent: 'Codex', latestAgentRun: withoutClaim.latestAgentRun }), {
    now,
    activeExecutions: [execution('implementing')],
  });
  assert.equal(managed?.source, 'managed');
  assert.equal(managed?.ownerLabel, 'Chat A1');
});

test('unknown lifecycle stages degrade to neutral Working', () => {
  const result = deriveTaskBoardLiveWorkProjection(task(), { now, activeExecutions: [execution('future-stage')] });
  assert.equal(result?.phase, 'working');
  assert.equal(result?.phaseLabel, 'Working');
});

test('projection service stays on lightweight execution/checkpoint reads', () => {
  const source = fs.readFileSync('src/server/services/taskBoardLiveWorkProjectionService.ts', 'utf8');
  assert.doesNotMatch(source, /inspectWorkspaceRecovery/);
  assert.doesNotMatch(source, /workspaceRecoveryService/);
  assert.doesNotMatch(source, /child_process|execFile|spawnSync/);
  assert.match(source, /queryExecutionSessions\(\{ taskId: task\.id, status: 'active', limit: 2 \}\)/);
});
