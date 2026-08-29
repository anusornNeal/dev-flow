import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-board-live-work-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { deriveTaskBoardLiveWorkProjection, getAgentOfficeMonitoringProjection } = await import('../../src/server/services/taskBoardLiveWorkProjectionService.js');
const { createProject, updateProject, deleteProject } = await import('../../src/server/repositories/projectRepository.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSessionRecord, saveExecutionSessionEvidence } = await import('../../src/server/repositories/executionSessionRepository.js');

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

function externalStatusLog(metadata: Record<string, unknown>, recordedAt = '2026-08-26T00:55:00.000Z') {
  return {
    id: 'external-task-status-op-native',
    timestamp: recordedAt,
    type: 'comment',
    message: `[external-task-status:v1] ${JSON.stringify({
      schema: 'external-task-status.v1',
      operationId: 'external-task-status-op-native',
      requestFingerprint: 'native-fingerprint',
      sourceStatus: 'todo',
      targetStatus: 'in-progress',
      changed: true,
      recordedAt,
      metadata,
      managedAuthorityOverlap: false,
      warnings: [],
    })}`,
  };
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

test('local-native external status projects Agent Office progress and attention without a managed claim', () => {
  const working = deriveTaskBoardLiveWorkProjection(task({
    claim: undefined,
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'IMPLEMENT_TASK', summary: 'editing native files', contextRef: 'ctx-native' })],
  }), { now });
  assert.equal(working?.source, 'agent');
  assert.equal(working?.ownerLabel, 'Codex Native');
  assert.equal(working?.ownerKind, 'agent');
  assert.equal(working?.phase, 'working');
  assert.equal(working?.activity, 'editing native files');

  const blocked = deriveTaskBoardLiveWorkProjection(task({
    claim: undefined,
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'RESOLVE_FAILURE', resultState: 'BLOCKED', summary: 'waiting for input' })],
  }), { now });
  assert.equal(blocked?.phase, 'blocked');
  assert.equal(blocked?.phaseLabel, 'Blocked');
  assert.equal(blocked?.blocked, true);

  const handoff = deriveTaskBoardLiveWorkProjection(task({
    claim: undefined,
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'IMPLEMENT_TASK', resultState: 'HANDOFF_READY', summary: 'safe boundary' })],
  }), { now });
  assert.equal(handoff?.phase, 'working');
  assert.equal(handoff?.phaseLabel, 'Handoff ready');
  assert.equal(handoff?.blocked, false);

  const oldHandoff = deriveTaskBoardLiveWorkProjection(task({
    claim: undefined,
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'IMPLEMENT_TASK', resultState: 'HANDOFF_READY', summary: 'durable safe boundary' }, '2026-08-26T00:20:00.000Z')],
  }), { now });
  assert.equal(oldHandoff?.phaseLabel, 'Handoff ready', 'explicit durable handoff must not decay into disconnected state');
  assert.equal(oldHandoff?.blocked, false);
});

test('stale local-native heartbeat becomes disconnected attention instead of permanent working state', () => {
  const stale = deriveTaskBoardLiveWorkProjection(task({
    claim: undefined,
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'IMPLEMENT_TASK', summary: 'last known native work', contextRef: 'ctx-stale' }, '2026-08-26T00:20:00.000Z')],
  }), { now });
  assert.equal(stale?.source, 'agent');
  assert.equal(stale?.phase, 'blocked');
  assert.equal(stale?.phaseLabel, 'Disconnected');
  assert.equal(stale?.blocked, true);
  assert.match(stale?.activity || '', /last known native work/i);
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

  const claimedWithoutSession = deriveTaskBoardLiveWorkProjection(task({ activeAgent: 'Codex', latestAgentRun: withoutClaim.latestAgentRun }), {
    now,
    activeExecutions: [],
  });
  assert.equal(claimedWithoutSession?.source, 'managed');
  assert.equal(claimedWithoutSession?.ownerLabel, 'Chat A1');
  assert.equal(claimedWithoutSession?.phase, 'inspecting');
  assert.equal(claimedWithoutSession?.phaseLabel, 'Claimed');
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
  assert.doesNotMatch(source, /getProjectOrchestrationProjection/);
  assert.doesNotMatch(source, /listExecutionSessionsForTask/);
  assert.match(source, /queryAgentOfficeTaskPage/);
  assert.match(source, /queryLatestExecutionSessionEvidence/);
  assert.match(source, /queryExecutionSessions\(\{ taskId: task\.id, status: 'active', limit: 2 \}\)/);
});

test('Agent Office composes managed, local-native, pipeline, attention and queue state without a separate status store', () => {
  const projectId = 'project-agent-office-monitor';
  const fresh = new Date().toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  createProject({
    id: projectId,
    name: 'Agent Office Monitor',
    repoUrl: 'https://example.test/agent-office.git',
    localPath: tempDir,
    taskIdPrefix: 'AOF',
    createdAt: fresh,
  } as any);

  const seed = (id: string, status: string, patch: Record<string, any> = {}) => {
    const value = {
      id,
      displayId: `AOF-${id.toUpperCase()}`,
      projectId,
      title: id,
      description: 'agent office fixture',
      status,
      priority: 'medium',
      category: 'backend',
      tags: [],
      targetFiles: [`src/${id}.ts`],
      checklist: [],
      logs: [],
      createdAt: fresh,
      updatedAt: fresh,
      ...patch,
    } as any;
    saveTask(value);
    return value;
  };

  seed('managed', 'in-progress', {
    claim: {
      sessionIdHash: 'managed-hash',
      ownershipEpochId: 'managed-epoch',
      workspaceId: 'ws-office-managed',
      ownerKind: 'chat',
      ownerLabel: 'Chat Office',
      claimedAt: fresh,
      expiresAt: future,
    },
  });
  seed('native', 'in-progress', {
    logs: [externalStatusLog({ worker: 'Codex Native', action: 'IMPLEMENT_TASK', summary: 'native repository work', contextRef: 'ctx-native-office' }, fresh)],
  });
  const staleAt = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  seed('native-stale', 'in-progress', {
    logs: [externalStatusLog({ worker: 'Codex Native Gone', action: 'IMPLEMENT_TASK', summary: 'last native heartbeat', contextRef: 'ctx-native-stale' }, staleAt)],
  });
  seed('ready', 'backlog');
  seed('blocked', 'backlog', { prerequisiteTaskIds: ['managed'] });

  createExecutionSessionRecord({
    id: 'exec-office-managed',
    projectId,
    taskId: 'managed',
    workspaceId: 'ws-office-managed',
    branch: '0737-test',
    baseRevision: null,
    repoRevision: 'office-revision',
    status: 'active',
    contextHandle: null,
    createdAt: fresh,
    updatedAt: fresh,
    expiresAt: future,
    endedAt: null,
  });
  saveExecutionSessionEvidence({
    id: 'lifecycle-office-managed',
    sessionId: 'exec-office-managed',
    kind: 'lifecycle-transition',
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: 'lifecycle-office-managed',
    contextHandle: null,
    stale: false,
    metadata: {
      fromStage: 'implementing',
      toStage: 'verifying',
      reasonCode: 'verification-started',
      originEvidenceId: 'office-verification-evidence',
      operationId: 'op-office-verification',
      evidenceKind: 'run_project_command',
      evidenceStatus: 'completed',
      sequence: 2,
      observedAt: fresh,
    },
    createdAt: fresh,
    updatedAt: fresh,
  });
  saveExecutionSessionEvidence({
    id: 'checkpoint-office-managed',
    sessionId: 'exec-office-managed',
    kind: 'checkpoint',
    path: null,
    repoRevision: null,
    fileRevision: null,
    revisionIdentity: 'op-office-verification',
    contextHandle: null,
    stale: false,
    metadata: {
      snapshot: checkpoint({
        id: 'checkpoint-office-managed',
        executionSessionId: 'exec-office-managed',
        updatedAt: fresh,
        stage: 'verifying',
        pendingOperations: [{
          operationId: 'op-office-verification',
          evidenceId: 'office-verification-evidence',
          kind: 'test-focused',
          status: 'accepted',
          observedAt: fresh,
        }],
      }),
    },
    createdAt: fresh,
    updatedAt: fresh,
  });

  const seedPipeline = (id: string, lifecycleStage: 'verifying' | 'committed' | 'finalized', operation?: { kind: string; status: 'accepted' | 'running' }) => {
    const workspaceId = `ws-office-${id}`;
    const executionSessionId = `exec-office-${id}`;
    seed(id, 'in-progress', {
      claim: {
        sessionIdHash: `${id}-hash`,
        ownershipEpochId: `${id}-epoch`,
        workspaceId,
        ownerKind: 'chat',
        ownerLabel: `Chat ${id}`,
        claimedAt: fresh,
        expiresAt: future,
      },
    });
    createExecutionSessionRecord({
      id: executionSessionId,
      projectId,
      taskId: id,
      workspaceId,
      branch: `0737-${id}`,
      baseRevision: null,
      repoRevision: 'office-revision',
      status: 'active',
      contextHandle: null,
      createdAt: fresh,
      updatedAt: fresh,
      expiresAt: future,
      endedAt: null,
    });
    saveExecutionSessionEvidence({
      id: `lifecycle-office-${id}`,
      sessionId: executionSessionId,
      kind: 'lifecycle-transition',
      path: null,
      repoRevision: null,
      fileRevision: null,
      revisionIdentity: `lifecycle-office-${id}`,
      contextHandle: null,
      stale: false,
      metadata: {
        fromStage: 'implementing',
        toStage: lifecycleStage,
        reasonCode: `office-${lifecycleStage}`,
        originEvidenceId: `office-${id}-evidence`,
        operationId: operation ? `op-office-${id}` : null,
        evidenceKind: operation?.kind || `office-${lifecycleStage}`,
        evidenceStatus: 'completed',
        sequence: 2,
        observedAt: fresh,
      },
      createdAt: fresh,
      updatedAt: fresh,
    });
    if (!operation) return;
    saveExecutionSessionEvidence({
      id: `checkpoint-office-${id}`,
      sessionId: executionSessionId,
      kind: 'checkpoint',
      path: null,
      repoRevision: null,
      fileRevision: null,
      revisionIdentity: `op-office-${id}`,
      contextHandle: null,
      stale: false,
      metadata: {
        snapshot: checkpoint({
          id: `checkpoint-office-${id}`,
          executionSessionId,
          updatedAt: fresh,
          stage: lifecycleStage,
          pendingOperations: [{
            operationId: `op-office-${id}`,
            evidenceId: `office-${id}-evidence`,
            kind: operation.kind,
            status: operation.status,
            observedAt: fresh,
          }],
        }),
      },
      createdAt: fresh,
      updatedAt: fresh,
    });
  };

  seedPipeline('verify-running', 'verifying', { kind: 'typecheck', status: 'running' });
  seedPipeline('integrating', 'committed');
  seedPipeline('finalizing', 'finalized');
  seedPipeline('cleanup', 'finalized', { kind: 'cleanup_session_workspace', status: 'running' });

  const result = getAgentOfficeMonitoringProjection({ limit: 10 });
  assert.equal(result.schema, 'agent-office-monitor.v1');
  assert.equal(result.scope, 'global');
  assert.equal(result.projectId, null);
  assert.equal(result.projects.items.some((entry: any) => entry.projectId === projectId && entry.projectName === 'Agent Office Monitor'), true);
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'managed')?.source, 'devflow-managed');
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'managed')?.ownerKind, 'chat');
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'native')?.source, 'worker-native');
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'native')?.action, 'IMPLEMENT_TASK');
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'native-stale')?.indicator, 'disconnected');
  assert.equal(result.workers.items.find((entry: any) => entry.taskId === 'native-stale')?.stale, true);
  assert.equal(result.pipeline.items.find((entry: any) => entry.taskId === 'managed')?.stage, 'waiting-verification');
  assert.equal(result.pipeline.items.find((entry: any) => entry.taskId === 'verify-running')?.stage, 'verifying');
  assert.equal(result.pipeline.items.find((entry: any) => entry.taskId === 'integrating')?.stage, 'integrating');
  assert.equal(result.pipeline.items.find((entry: any) => entry.taskId === 'finalizing')?.stage, 'finalizing');
  assert.equal(result.pipeline.items.find((entry: any) => entry.taskId === 'cleanup')?.stage, 'cleanup');
  assert.equal(result.queue.counts.ready >= 1, true);
  assert.equal(result.queue.counts.execution >= 1, true);
  assert.equal(result.queue.counts.attention >= 1, true);
  assert.equal(result.queue.counts.blocked >= 1, true);
  assert.equal(result.queue.items.ready.some((entry: any) => entry.taskId === 'ready'), true);
  assert.equal(result.queue.items.blocked.some((entry: any) => entry.taskId === 'blocked'), true);

  const bounded = getAgentOfficeMonitoringProjection({ limit: 1 });
  assert.equal(bounded.workers.items.length <= 1, true);
  assert.equal(bounded.pipeline.items.length <= 1, true);
  for (const entries of Object.values(bounded.queue.items) as any[]) assert.equal(entries.length <= 1, true);
});

test('Agent Office API is GET-only, global and bounded', async () => {
  const express = (await import('express')).default;
  const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
  const projectId = 'project-agent-office-route';
  const createdAt = new Date().toISOString();
  const project = {
    id: projectId,
    name: 'Agent Office Route',
    repoUrl: 'https://example.test/agent-office-route.git',
    localPath: tempDir,
    taskIdPrefix: 'AOR',
    createdAt,
  };
  createProject(project as any);
  for (const id of ['route-ready-a', 'route-ready-b']) {
    saveTask({
      id,
      displayId: id.toUpperCase(),
      projectId,
      title: id,
      description: 'route fixture',
      status: 'backlog',
      priority: 'medium',
      category: 'backend',
      tags: [],
      targetFiles: [`src/${id}.ts`],
      checklist: [],
      logs: [],
      createdAt,
      updatedAt: createdAt,
    } as any);
  }
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerApiRoutes(app, { state: { countersCache: {}, projectsCache: [project], skillsRegistry: [] } as any, writeAgentLog: () => {} });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Agent Office test server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(`${base}/api/agent-office?projectId=${encodeURIComponent(projectId)}&limit=1`);
    assert.equal(response.status, 200);
    const body: any = await response.json();
    assert.equal(body.scope, 'global');
    assert.equal(body.projectId, null);
    assert.equal(body.limit, 1);
    assert.equal(body.queue.items.ready.length, 1);
    assert.equal(body.queue.truncated.ready, true);

    const missingProject = await fetch(`${base}/api/agent-office`);
    assert.equal(missingProject.status, 200);
    const missingBody: any = await missingProject.json();
    assert.equal(missingBody.scope, 'global');
    assert.equal(missingBody.projectId, null);

    const mutationAttempt = await fetch(`${base}/api/agent-office?projectId=${encodeURIComponent(projectId)}`, { method: 'POST' });
    assert.equal(mutationAttempt.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('Agent Office global projection keeps project identity unambiguous and filters stale project/task rows', () => {
  const createdAt = new Date().toISOString();
  const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const projectA = { id: 'project-agent-office-global-a', name: 'Global Alpha', repoUrl: 'https://example.test/global-alpha.git', localPath: tempDir, taskIdPrefix: 'GA', createdAt };
  const projectB = { id: 'project-agent-office-global-b', name: 'Global Beta', repoUrl: 'https://example.test/global-beta.git', localPath: tempDir, taskIdPrefix: 'GB', createdAt };
  const deletedProject = { id: 'project-agent-office-global-deleted', name: 'Global Deleted', repoUrl: 'https://example.test/global-deleted.git', localPath: tempDir, taskIdPrefix: 'GD', createdAt };
  createProject(projectA as any);
  createProject(projectB as any);
  createProject(deletedProject as any);

  const seedGlobal = (projectId: string, id: string, patch: Record<string, any> = {}) => saveTask({
    id, displayId: id.toUpperCase(), projectId, title: 'Duplicate-looking task', description: 'global projection fixture',
    status: 'in-progress', priority: 'medium', category: 'backend', tags: [], targetFiles: [`src/${id}.ts`], checklist: [], logs: [],
    createdAt, updatedAt: createdAt, ...patch,
  } as any);

  seedGlobal(projectA.id, 'global-active-a', { displayId: 'DUP-001', claim: {
    sessionIdHash: 'global-a-hash', ownershipEpochId: 'global-a-epoch', workspaceId: 'ws-global-a', ownerKind: 'chat',
    ownerLabel: 'Chat Global A', claimedAt: createdAt, expiresAt: future,
  } });
  createExecutionSessionRecord({
    id: 'exec-global-a', projectId: projectA.id, taskId: 'global-active-a', workspaceId: 'ws-global-a', branch: 'global-a',
    baseRevision: null, repoRevision: 'global-a-revision', status: 'active', contextHandle: null,
    createdAt, updatedAt: createdAt, expiresAt: future, endedAt: null,
  });
  seedGlobal(projectB.id, 'global-active-b', { displayId: 'DUP-001', logs: [externalStatusLog({ worker: 'Codex Global B', action: 'IMPLEMENT_TASK', summary: 'global native work', contextRef: 'ctx-global-b' }, createdAt)] });
  seedGlobal(projectB.id, 'global-ready-cross-scope', { status: 'backlog', targetFiles: ['src/global-active-a.ts'] });
  seedGlobal(projectB.id, 'global-done', { status: 'done' });
  seedGlobal(projectA.id, 'global-archived', { status: 'backlog', archivedAt: createdAt });
  seedGlobal(deletedProject.id, 'global-deleted-project-task');
  deleteProject(deletedProject.id);
  updateProject({ ...projectB, name: 'Global Beta Renamed' } as any);

  const result = getAgentOfficeMonitoringProjection({ limit: 50 });
  const rows = result.workers.items.filter((entry: any) => entry.taskId === 'global-active-a' || entry.taskId === 'global-active-b');
  assert.equal(rows.length, 2);
  assert.equal(rows.find((entry: any) => entry.taskId === 'global-active-a')?.projectName, 'Global Alpha');
  assert.equal(rows.find((entry: any) => entry.taskId === 'global-active-b')?.projectName, 'Global Beta Renamed');
  assert.equal(rows[0].displayId === rows[1].displayId, true);
  assert.notEqual(rows[0].projectId, rows[1].projectId);
  assert.equal(result.projects.items.some((entry: any) => entry.projectId === deletedProject.id), false);
  const queueRows = Object.values(result.queue.items).flat() as any[];
  assert.equal(queueRows.some((entry) => entry.taskId === 'global-done'), false);
  assert.equal(queueRows.some((entry) => entry.taskId === 'global-archived'), false);
  assert.equal(queueRows.some((entry) => entry.taskId === 'global-deleted-project-task'), false);
  assert.equal(result.queue.items.ready.some((entry: any) => entry.taskId === 'global-ready-cross-scope'), true);
  const again = getAgentOfficeMonitoringProjection({ limit: 50 });
  assert.deepEqual(
    again.workers.items.map((entry: any) => `${entry.projectId}:${entry.taskId}`),
    result.workers.items.map((entry: any) => `${entry.projectId}:${entry.taskId}`),
  );
  assert.equal(typeof result.partial, 'boolean');
  assert.equal(typeof result.sources.tasks.truncated, 'boolean');
  assert.equal(typeof result.sources.activeExecutions.truncated, 'boolean');
  assert.equal(typeof result.sources.checkpoints.truncated, 'boolean');
});

