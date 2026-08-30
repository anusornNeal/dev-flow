import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-health-'));
const runtimeSourceRoot = path.join(tempRoot, 'runtime-source');
fs.mkdirSync(runtimeSourceRoot, { recursive: true });
git(runtimeSourceRoot, ['init']);
git(runtimeSourceRoot, ['config', 'user.name', 'DevFlow Test']);
git(runtimeSourceRoot, ['config', 'user.email', 'devflow@example.com']);
fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source v1\n');
git(runtimeSourceRoot, ['add', '.']);
git(runtimeSourceRoot, ['commit', '-m', 'runtime source v1']);
git(runtimeSourceRoot, ['branch', '-M', 'develop']);
process.env.DEVFLOW_RUNTIME_SOURCE_ROOT = runtimeSourceRoot;
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-health-db-${path.basename(tempRoot)}.sqlite`);
process.env.DEVFLOW_JOBS_DIR = path.join(os.tmpdir(), `devflow-health-jobs-${path.basename(tempRoot)}`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const emergencyOps = await import('../../src/server/repositories/lifecycleEmergencyOperationRepository.js');

const workflowHealthModule = await import('../../src/server/services/workflowHealthService.js');
const { getWorkflowHealth, getChatGptHarnessHealthSnapshot } = workflowHealthModule;const {
  clearResidualVerificationProcessStateForTests,
  registerResidualVerificationProcess,
} = await import('../../src/server/services/residualVerificationProcessService.js');
const { getToolDefinitionByName, getCapabilityCatalog } = await import('../../src/server/contracts/devflowContract.js');
const serverEvents = await import('../../src/server/services/serverEventService.js');
const { clearToolCallRecords, recordToolCall, flushPerformanceTelemetry } = await import('../../src/server/services/mcpToolMonitor.js');
const { default: db } = await import('../../src/db/index.js');
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createExecutionSessionRecord, queryExecutionSessions, updateExecutionSessionRecord } = await import('../../src/server/repositories/executionSessionRepository.js');
const sessionWorkspaces = await import('../../src/server/services/sessionWorkspaceService.js');
const checkpoints = await import('../../src/server/services/executionCheckpointService.js');
const {
  createJob,
  updateJobStatus,
  clearRecentJobCache,
  getRecentJobCacheStats,
  claimJob,
  requeueJobForRecovery,
  requestJobCancellation,
  writeJobResult,
  getJob,
} = await import('../../src/server/repositories/mcpToolJobRepository.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function createRepo(name: string) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  createProject({ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo });
  return repo;
}

function stateFor(repo: string): any {
  return {
    projectsCache: [{ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo }],
  };
}

function seedHealthTask(id: string, displayId: string, claim?: any) {
  const now = new Date().toISOString();
  const task = {
    id,
    displayId,
    title: 'Health lifecycle fixture',
    description: 'Exercise read-only lifecycle health diagnostics.',
    projectId: 'project-health',
    status: 'in-progress',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['base.txt'],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt: now,
    updatedAt: now,
    ...(claim ? { claim: {
      sessionIdHash: `health-${id}`,
      ownerKind: 'chat',
      ownerLabel: 'Health Fixture',
      claimedAt: now,
      ...claim,
    } } : {}),
  } as any;
  saveTask(task);
  return task;
}

function seedHealthExecution(id: string, taskId: string, workspaceId: string) {
  const now = new Date();
  return createExecutionSessionRecord({
    id,
    projectId: 'project-health',
    taskId,
    workspaceId,
    branch: 'devflow/ws/' + id,
    baseRevision: 'base',
    repoRevision: 'candidate',
    status: 'active',
    contextHandle: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 60_000).toISOString(),
    endedAt: null,
  });
}

function createHealthWorkspace(repo: string, sessionId: string, taskDisplayId: string) {
  return sessionWorkspaces.createOrReuseSessionWorkspace(
    { id: 'project-health', localPath: repo },
    sessionId,
    { taskDisplayId },
  );
}

function retireHealthWorkspace(sessionId: string, workspaceId: string) {
  const now = new Date().toISOString();
  updateExecutionSessionRecord(sessionId, { status: 'cancelled', updatedAt: now, endedAt: now });
  sessionWorkspaces.cleanupSessionWorkspace(workspaceId);
}

test('getWorkflowHealth returns ok for a clean repo', () => {
  const repo = createRepo('clean');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.git.clean, true);
  assert.equal(result.capabilities.keyToolsPresent.get_repo_context_bundle, true);
  assert.equal(result.capabilities.asyncToolCount > 0, true);
  assert.equal(typeof result.diagnostics.isolation.waits.workspaceLockWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.waits.capacityWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.admissionWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.queueWait.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.execution.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.phases.responseHandoff.p95Ms, 'number');
  assert.equal(typeof result.diagnostics.isolation.workspaces.known, 'number');
  assert.equal(typeof result.diagnostics.isolation.integrations.conflicts, 'number');
  assert.equal(Array.isArray(result.diagnostics.repoCaches.domains), true);
  assert.equal(result.diagnostics.repoCaches.domains.length <= 8, true);
  assert.equal(result.diagnostics.repoCaches.domains.every((domain: any) => typeof domain.hitRate === 'number'), true);
});

test('workflow health reports closure recovery capability drift from the active advertised surface', () => {
  const setCapabilityCatalogForTests = (workflowHealthModule as any).__setWorkflowHealthCapabilityCatalogForTests;
  assert.equal(typeof setCapabilityCatalogForTests, 'function');
  if (typeof setCapabilityCatalogForTests !== 'function') return;

  const realCatalog = getCapabilityCatalog() as any;
  const staleCatalog = {
    ...realCatalog,
    recovery: {
      ...realCatalog.recovery,
      ready: false,
      missingCapabilityIds: ['orphan-cleanup'],
      capabilities: (realCatalog.recovery?.capabilities || []).map((entry: any) =>
        entry.id === 'orphan-cleanup' ? { ...entry, advertised: false, callable: false } : entry),
    },
  };

  setCapabilityCatalogForTests(() => staleCatalog);
  try {
    const repo = createRepo('capability-drift');
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    assert.equal(full.status, 'error');
    assert.equal(full.ok, false);
    assert.equal(full.checks.capabilityCatalog, false);
    assert.equal(full.capabilities.recovery.ready, false);
    assert.deepEqual(full.capabilities.recovery.missingCapabilityIds, ['orphan-cleanup']);
    assert.equal(compact.runtime.capabilities.recoveryReady, false);
    assert.match(full.recommendations.join('\n'), /closure recovery capability drift/i);
    assert.doesNotMatch(full.recommendations.join('\n'), /cleanup_orphan_executions/);
  } finally {
    setCapabilityCatalogForTests(null);
  }
});

test('workflow health separates server recovery readiness from stale or unobserved client parity', () => {
  const repo = createRepo('client-recovery-parity');
  const full = getWorkflowHealth(stateFor(repo), {
    projectId: 'project-health',
    responseMode: 'full',
    previousToolSurfaceIdentity: '0'.repeat(64),
    clientToolsVisible: true,
  }) as any;
  assert.equal(full.capabilities.recovery.serverReady, true);
  assert.equal(full.capabilities.recovery.clientObserved.state, 'stale');
  assert.equal(full.capabilities.recovery.endToEnd.state, 'not-ready');
  assert.equal(full.capabilities.recovery.ready, false);
  assert.match(full.recommendations.join('\n'), /client.*recovery|recovery.*client|refresh|reconnect/i);

  const missingRequiredTool = getWorkflowHealth(stateFor(repo), {
    projectId: 'project-health',
    responseMode: 'full',
    clientToolsVisible: true,
    clientUnavailableToolNames: ['adopt_task_execution_owned_changes'],
  }) as any;
  assert.equal(missingRequiredTool.capabilities.recovery.serverReady, true);
  assert.equal(missingRequiredTool.capabilities.recovery.clientObserved.state, 'missing-tools');
  assert.deepEqual(missingRequiredTool.capabilities.recovery.clientObserved.missingRequiredRecoveryToolNames, ['adopt_task_execution_owned_changes']);
  assert.equal(missingRequiredTool.capabilities.recovery.endToEnd.ready, false);
  assert.ok(missingRequiredTool.capabilities.recovery.endToEnd.reasonCodes.includes('CLIENT_REQUIRED_RECOVERY_TOOLS_MISSING'));
  assert.match(missingRequiredTool.recommendations.join('\n'), /refresh|reconnect/i);

  const unobserved = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  assert.equal(unobserved.capabilities.recovery.serverReady, true);
  assert.equal(unobserved.capabilities.recovery.clientObserved.state, 'unknown');
  assert.equal(unobserved.capabilities.recovery.endToEnd.state, 'unknown');
  assert.equal(unobserved.capabilities.recovery.ready, null);
});

test('workflow health exposes bounded audited break-glass aftermath without mutating it', () => {
  const repo = createRepo('break-glass-observability');
  const task = seedHealthTask('task-health-break-glass', 'DVF-HBG-1');
  const now = new Date().toISOString();
  const operation = emergencyOps.createLifecycleEmergencyOperation({
    id: 'health-break-glass-active-1',
    requestDigest: 'health-break-glass-digest',
    action: 'release-ownership-preserve-wip',
    projectId: 'project-health',
    taskId: task.id,
    workspaceId: 'ws-health-break-glass',
    executionSessionId: null,
    ownershipEpochId: null,
    actorLabel: 'Health Operator',
    reason: 'observe unresolved audited recovery',
    status: 'partial',
    request: { operationId: 'health-break-glass-active-1' },
    beforeSnapshot: { classification: 'recoverable' },
    afterSnapshot: { classification: 'recoverable' },
    bypassedGates: ['TASK_STATUS_PROJECTION_DRIFT'],
    hardChecks: [{ code: 'PROJECT_IDENTITY', passed: true }],
    evidence: { bounded: true },
    wipDisposition: 'preserved',
    result: { cleanupPending: true },
    failure: { code: 'WORKSPACE_ACTIVE', message: 'synthetic pending cleanup' },
    retryCount: 0,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  });
  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
  assert.equal(full.diagnostics.breakGlass.unresolvedCount >= 1, true);
  assert.equal(full.diagnostics.breakGlass.recent.some((entry: any) => entry.id === operation.id && entry.status === 'partial'), true);
  assert.equal(compact.recovery.breakGlass.unresolvedCount >= 1, true);
  assert.equal(emergencyOps.getLifecycleEmergencyOperation(operation.id)?.status, 'partial', 'health read must not advance emergency state');
  emergencyOps.updateLifecycleEmergencyOperation(operation.id, { status: 'completed', completedAt: new Date().toISOString() });
});

test('compact health preserves operational warnings while cutting response bytes by at least half', () => {
  const repo = createRepo('compact-shape');
  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');

  assert.equal(compact.ok, true);
  assert.equal(compact.status, 'ok');
  assert.equal(compact.git.clean, true);
  assert.equal(compact.git.operation.blocked, false);
  assert.equal(typeof compact.queue.depth, 'number');
  assert.equal(typeof compact.queue.capacity.saturated, 'boolean');
  assert.equal(typeof compact.runtime.search.backend, 'string');
  assert.equal(Array.isArray(compact.runtime.repoCaches.domains), true);
  assert.equal(compact.runtime.repoCaches.domains.length <= 3, true);
  assert.equal(compact.runtime.repoCaches.domains.some((domain: any) => domain.name === 'local-file-search'), true);
  assert.equal(compact.runtime.repoCaches.domains.every((domain: any) => typeof domain.hits === 'number' && typeof domain.misses === 'number' && typeof domain.hitRate === 'number' && typeof domain.invalidations === 'number' && typeof domain.lineageToken === 'string'), true);
  assert.equal(compact.runtime.capabilities.keyToolsPresent.get_repo_context_bundle, true);
  assert.equal(Array.isArray(compact.regressions), true);
  assert.equal(typeof compact.recovery.hasVerifiedGoodBackup, 'boolean');
  assert.equal(Array.isArray(compact.recommendations), true);
  assert.equal(compact.diagnostics, undefined, 'compact mode must omit deep diagnostics');
  assert.equal(compact.capabilities, undefined, 'compact mode must omit the full capability packet');
  assert.equal(compactBytes <= fullBytes * 0.5, true, `expected compact <=50% of full (${compactBytes} vs ${fullBytes})`);
  assert.equal(compactBytes <= 3_000, true, `expected ordinary compact health <=3KB, got ${compactBytes} bytes`);
  console.log(`[health-bytes] full=${fullBytes} compact=${compactBytes} reduction=${Math.round((1 - compactBytes / fullBytes) * 100)}%`);
});

test('workflow health marks failed-job evidence stale when runtime source lags the repository', () => {
  const repo = createRepo('stale-failure-evidence');
  const loadedRevision = git(runtimeSourceRoot, ['rev-parse', 'HEAD']);
  fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source v2\n');
  git(runtimeSourceRoot, ['add', 'runtime-source.txt']);
  git(runtimeSourceRoot, ['commit', '-m', 'runtime source v2']);
  createJob('job-health-stale-evidence', 'execute_repo_query_plan', { steps: [] }, `repo:${repo}`);
  updateJobStatus('job-health-stale-evidence', { status: 'failed', failureSummary: 'synthetic stale-runtime failure' });
  try {
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    assert.equal(full.diagnostics.failedJobEvidence.freshness, 'stale-runtime');
    assert.equal(full.diagnostics.failedJobEvidence.reasonCode, 'FAILED_JOB_EVIDENCE_STALE_RUNTIME');
    assert.equal(typeof full.diagnostics.failedJobEvidence.loadedRevision, 'string');
    assert.equal(typeof full.diagnostics.failedJobEvidence.currentRevision, 'string');
    assert.equal(compact.failures.evidence.freshness, 'stale-runtime');
    assert.match(full.recommendations.join('\n'), /revalidate.*current source/i);
  } finally {
    db.prepare('DELETE FROM mcp_tool_jobs WHERE job_id = ?').run('job-health-stale-evidence');
    clearRecentJobCache();
    git(runtimeSourceRoot, ['reset', '--hard', loadedRevision]);
  }
});

test('compact health keeps grouped failure and recovery warning context without verbose examples', () => {
  const repo = createRepo('compact-warning');
  createJob('job-health-compact-failed', 'run_project_command', { command: 'verify' }, `repo:${repo}`);
  updateJobStatus('job-health-compact-failed', { status: 'failed', failureSummary: 'synthetic compact failure' });

  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'summary' }) as any;
  const fullBytes = Buffer.byteLength(JSON.stringify(full), 'utf8');
  const compactBytes = Buffer.byteLength(JSON.stringify(compact), 'utf8');
  assert.equal(compact.status, 'warning');
  assert.equal(compact.failures.total > 0, true);
  assert.equal(compact.failures.groups.some((group: any) => group.toolName === 'run_project_command'), true);
  assert.equal(compact.failures.groups.some((group: any) => 'examples' in group), false);
  assert.equal(compact.failures.evidence.freshness, 'current');
  assert.equal(compact.failures.evidence.reasonCode, 'FAILED_JOB_EVIDENCE_CURRENT_RUNTIME');
  assert.equal(compact.recovery.hasVerifiedGoodBackup, false);
  assert.match(compact.recommendations.join('\n'), /run_project_command/);
  assert.equal(compactBytes <= fullBytes * 0.5, true, `expected warning compact <=50% of full (${compactBytes} vs ${fullBytes})`);
  db.prepare('DELETE FROM mcp_tool_jobs WHERE job_id = ?').run('job-health-compact-failed');
  clearRecentJobCache();
});

test('compact health surfaces active current SLO regressions without historical payloads', () => {
  const repo = createRepo('compact-current-regression');
  clearToolCallRecords();
  const now = Date.now();
  for (let index = 0; index < 3; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 1_500 + index,
      timestamp: now - 10 + index,
    });
  }
  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact', windowMs: 1_000 }) as any;
  assert.equal(compact.status, 'warning');
  assert.equal(compact.regressions.some((entry: any) => entry.toolName === 'search_local_files' && entry.status === 'regressed'), true);
  assert.equal(compact.diagnostics, undefined);
  assert.match(compact.recommendations.join('\n'), /Performance SLO regression/);
  clearToolCallRecords();
});

test('compact project health does not Git-inspect active claimed workspaces', () => {
  const repo = createRepo('compact-active-claim-no-recovery-inspection');
  const workspace = createHealthWorkspace(repo, `compact-active-claim-workspace-${path.basename(tempRoot)}`, 'DVF-HEALTH-ACTIVE-1');
  const task = seedHealthTask('task-health-active-claim', 'DVF-HEALTH-ACTIVE-1', {
    workspaceId: workspace.workspaceId,
    ownershipEpochId: null,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const execution = seedHealthExecution('exec-health-active-claim', task.id, workspace.workspaceId);
  const setRecoveryInspector = (workflowHealthModule as any).__setWorkflowHealthWorkspaceRecoveryInspectorForTests;
  assert.equal(typeof setRecoveryInspector, 'function');
  let inspectionCount = 0;

  try {
    setRecoveryInspector(() => {
      inspectionCount += 1;
      throw new Error('compact project health must not perform Git-backed workspace recovery inspection');
    });
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    assert.equal(inspectionCount, 0);
    assert.equal(compact.harness.aggregate.activeClaimCount, 1);
    assert.equal(compact.harness.aggregate.activeExecutionCount, 1);
    assert.equal(compact.harness.hardBlockers.includes('PROJECT_RECOVERY_SCAN_DEFERRED'), true);
  } finally {
    if (typeof setRecoveryInspector === 'function') setRecoveryInspector(null);
    saveTask({
      ...task,
      claim: { ...task.claim, expiresAt: new Date(0).toISOString() },
      updatedAt: new Date().toISOString(),
    });
    retireHealthWorkspace(execution.id, workspace.workspaceId);
  }
});

test('compact project health defers unrelated registry recovery scans but fails closed', () => {
  const repo = createRepo('compact-deferred-recovery-scan');
  const workspace = createHealthWorkspace(repo, `compact-deferred-recovery-session-${path.basename(tempRoot)}`, 'DVF-HEALTH-DEFER-1');

  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;

  assert.equal(compact.harness.hardBlockers.includes('PROJECT_RECOVERY_SCAN_DEFERRED'), true);
  assert.equal(compact.harness.aggregate.workspaceIds.includes(workspace.workspaceId), false);
  assert.equal(full.diagnostics.harness.hardBlockers.includes('PROJECT_RECOVERY_SCAN_DEFERRED'), false);
  assert.equal(typeof full.performance.phases.sloMs, 'number');
  assert.equal(typeof full.performance.phases.recoveryMs, 'number');
  assert.equal(typeof full.performance.phases.harnessMs, 'number');

  sessionWorkspaces.cleanupSessionWorkspace(workspace.workspaceId, { force: true });
});

test('full and debug health modes preserve the detailed diagnostic shape', () => {
  const repo = createRepo('full-debug-shape');
  for (const responseMode of ['full', 'debug']) {
    const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode }) as any;
    assert.equal(typeof result.capabilities.toolCount, 'number');
    assert.equal(typeof result.diagnostics.isolation.phases.queueWait.p95Ms, 'number');
    assert.equal(Array.isArray(result.diagnostics.performance.history.comparisons), true);
    assert.equal(Array.isArray(result.diagnostics.failedJobSummaries), true);
  }
});

test('devflow_health_check contract defaults MCP requests to compact and permits explicit full diagnostics', () => {
  const tool = getToolDefinitionByName('devflow_health_check');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema?.properties?.responseMode?.enum, ['compact', 'summary', 'full', 'debug']);
  assert.equal(tool.inputSchema?.properties?.previousContractVersion?.type, 'string');
  assert.equal(tool.inputSchema?.properties?.previousRuntimeInstanceId?.type, 'string');
  assert.equal(tool.inputSchema?.properties?.previousToolSurfaceIdentity?.type, 'string');
  assert.equal(tool.inputSchema?.properties?.clientToolsVisible?.type, 'boolean');
  assert.equal(tool.buildHttpRequest({ projectId: 'project-health' }).path.includes('responseMode=compact'), true);
  assert.equal(tool.buildHttpRequest({ projectId: 'project-health', responseMode: 'full' }).path.includes('responseMode=full'), true);
});

test('task-scoped health discovers orphan execution', () => {
  const repo = createRepo('task-orphan-health');
  const task = seedHealthTask('task-health-orphan', 'DVF-HEALTH-ORPHAN');
  seedHealthExecution('exec-health-orphan', task.id, 'ws-health-orphan');
  const contract: any = getToolDefinitionByName('devflow_health_check');
  assert.equal(contract.inputSchema.properties.taskId.type, 'string');
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', taskId: task.displayId });
  assert.equal(health.scope, 'task');
  assert.equal(health.execution.sessionId, 'exec-health-orphan');
  assert.notEqual(health.status, 'idle');
  assert.equal(health.drift[0].code, 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM');
});

test('workspace-scoped health surfaces active execution ambiguity', () => {
  const repo = createRepo('workspace-ambiguous-health');
  seedHealthExecution('exec-health-ambiguous-a', 'task-health-ambiguous-a', 'ws-health-ambiguous');
  seedHealthExecution('exec-health-ambiguous-b', 'task-health-ambiguous-b', 'ws-health-ambiguous');
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', workspaceId: 'ws-health-ambiguous' });
  assert.equal(health.scope, 'workspace');
  assert.equal(health.status, 'blocked');
  assert.equal(health.execution.stage, 'ambiguous');
  assert.equal(health.drift[0].code, 'MULTIPLE_ACTIVE_EXECUTIONS_FOR_WORKSPACE');
});

test('task-scoped health fails closed when matching claim and execution point at missing workspace metadata', () => {
  const repo = createRepo('task-missing-workspace-metadata');
  const workspace = createHealthWorkspace(repo, 'health-missing-metadata-session', 'DVF-HEALTH-MISSING-901');
  sessionWorkspaces.cleanupSessionWorkspace(workspace.workspaceId, { force: true });
  const workspaceId = workspace.workspaceId;
  const task = seedHealthTask('task-health-missing-metadata', 'DVF-HEALTH-MISSING-901', {
    workspaceId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const execution = seedHealthExecution('exec-health-missing-metadata', task.id, workspaceId);
  checkpoints.recordExecutionPendingOperationReference(execution.id, {
    operationId: 'job-health-missing-workspace',
    evidenceId: 'mcp-job:job-health-missing-workspace',
    kind: 'mcp-tool-job:run_project_command',
    status: 'running',
  });

  const before = JSON.stringify(queryExecutionSessions({ taskId: task.id, limit: 20 }));
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', taskId: task.displayId });
  const after = JSON.stringify(queryExecutionSessions({ taskId: task.id, limit: 20 }));
  const missing = health.drift.find((entry: any) => entry.code === 'WORKSPACE_METADATA_MISSING');

  assert.equal(health.status, 'blocked');
  assert.deepEqual(missing?.taskIds, [task.id]);
  assert.deepEqual(missing?.workspaceIds, [workspaceId]);
  assert.deepEqual(missing?.executionSessionIds, [execution.id]);
  assert.equal(health.drift.some((entry: any) => entry.code === 'PENDING_DURABLE_OPERATIONS'), true);
  assert.equal(after, before, 'health must not rotate or rewrite execution authority');
});

test('task-scoped health distinguishes metadata-present workspace root or Git identity failure', () => {
  const repo = createRepo('task-invalid-workspace-root');
  const workspace = createHealthWorkspace(repo, 'health-invalid-root-session', 'DVF-HEALTH-ROOT-902');
  const task = seedHealthTask('task-health-invalid-root', 'DVF-HEALTH-ROOT-902', {
    workspaceId: workspace.workspaceId,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const execution = seedHealthExecution('exec-health-invalid-root', task.id, workspace.workspaceId);
  fs.rmSync(workspace.root, { recursive: true, force: true });

  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.displayId });
  const invalid = health.drift.find((entry: any) => entry.code === 'WORKSPACE_ROOT_OR_IDENTITY_INVALID');

  assert.equal(health.status, 'blocked');
  assert.deepEqual(invalid?.workspaceIds, [workspace.workspaceId]);
  assert.deepEqual(invalid?.executionSessionIds, [execution.id]);
  assert.equal(health.drift.some((entry: any) => entry.code === 'WORKSPACE_METADATA_MISSING'), false);
});

test('workspace-scoped health fails closed for a missing workspace id', () => {
  const repo = createRepo('workspace-missing-id');
  const workspaceId = 'ws-health-does-not-exist';
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', workspaceId });

  assert.equal(health.scope, 'workspace');
  assert.equal(health.status, 'blocked');
  assert.equal(health.drift.some((entry: any) => entry.code === 'WORKSPACE_METADATA_MISSING'), true);
  assert.equal(health.drift.some((entry: any) => entry.code === 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM'), false);
});

test('valid exact workspace health is read-only and does not depend on active workspace acquisition', () => {
  const repo = createRepo('workspace-valid-not-acquired');
  const workspace = createHealthWorkspace(repo, 'health-valid-not-acquired-session', 'DVF-HEALTH-VALID-903');
  const before = sessionWorkspaces.getSessionWorkspaceMetadataForRecovery(workspace.workspaceId);

  const first: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', workspaceId: workspace.workspaceId });
  const second: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', workspaceId: workspace.workspaceId });
  const after = sessionWorkspaces.getSessionWorkspaceMetadataForRecovery(workspace.workspaceId);

  assert.equal(first.status, 'idle');
  assert.deepEqual(first.drift, []);
  assert.deepEqual(second.drift, []);
  assert.equal(after?.lastUsedAt, before?.lastUsedAt, 'health must not touch managed workspace metadata');
});

test('project-scoped health reports aggregate activity without fabricated execution', () => {
  const repo = createRepo('project-aggregate-health');
  seedHealthExecution('exec-health-project-active', 'task-health-project-active', 'ws-health-project-active');
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health' });
  assert.equal(health.scope, 'project-aggregate');
  assert.equal(health.aggregate.activeExecutionCount >= 1, true);
  assert.equal(health.execution, undefined);
});

test('project-scoped health ignores large terminal history when active lifecycle authority is complete', () => {
  const projectId = 'project-health-truncated-idle';
  const repo = path.join(tempRoot, projectId);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  createProject({ id: projectId, name: 'Truncated Idle Health Fixture', repoUrl: 'https://example.com/health-truncated-idle', localPath: repo });

  const now = new Date().toISOString();
  for (let index = 0; index < 101; index += 1) {
    saveTask({
      id: `task-health-truncated-idle-${index}`,
      displayId: `DVF-HEALTH-TRUNCATED-IDLE-${index}`,
      title: 'Historical completed health fixture',
      description: 'Force bounded project task aggregation without live lifecycle authority.',
      projectId,
      status: 'done',
      priority: 'low',
      category: 'backend',
      tags: [],
      targetFiles: ['base.txt'],
      checklist: [],
      logs: [],
      bugs: [],
      images: [],
      createdAt: now,
      updatedAt: now,
    } as any);
  }

  const health: any = getChatGptHarnessHealthSnapshot({
    projectsCache: [{ id: projectId, name: 'Truncated Idle Health Fixture', repoUrl: 'https://example.com/health-truncated-idle', localPath: repo }],
  } as any, { projectId });
  const truncation = health.drift.find((entry: any) => entry.code === 'PROJECT_LIFECYCLE_SCAN_TRUNCATED');

  assert.equal(health.aggregate.activeExecutionCount, 0);
  assert.equal(health.aggregate.activeClaimCount, 0);
  assert.equal(health.aggregate.pendingOperationCount, 0);
  assert.equal(health.aggregate.actionableWorkspaceCount, 0);
  assert.equal(health.aggregate.canonicalLiveAuthorityCount, 0);
  assert.equal(health.aggregate.truncated, false);
  assert.equal(truncation, undefined);
  assert.equal(health.hardBlockers.includes('PROJECT_LIFECYCLE_SCAN_TRUNCATED'), false);
  assert.equal(health.status, 'idle');
});

test('project-scoped health resolves active claims independently of unrelated task history while surfacing missing workspace authority', () => {
  const repo = createRepo('project-aggregate-late-claim-health');
  for (let index = 0; index < 105; index += 1) {
    seedHealthTask(`task-health-filler-${index}`, `DVF-HEALTH-FILLER-${index}`);
  }
  const task = seedHealthTask('task-health-late-claimed', 'DVF-HEALTH-LATE-CLAIMED', {
    workspaceId: 'ws-health-late-claimed',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  seedHealthExecution('exec-health-late-claimed', task.id, 'ws-health-late-claimed');

  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health' });
  const falseOrphan = health.drift.find((entry: any) =>
    entry.code === 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM'
      && entry.executionSessionIds?.includes('exec-health-late-claimed'));

  assert.equal(falseOrphan, undefined);
  assert.equal(health.aggregate.activeClaimCount >= 1, true);
  const missingWorkspace = health.drift.find((entry: any) =>
    entry.code === 'WORKSPACE_METADATA_MISSING'
      && entry.workspaceIds?.includes('ws-health-late-claimed'));

  assert.ok(missingWorkspace);
  assert.equal(missingWorkspace.executionSessionIds?.includes('exec-health-late-claimed'), true);
  assert.equal(health.aggregate.truncated, false);
  assert.equal(health.drift.some((entry: any) => entry.code === 'PROJECT_LIFECYCLE_SCAN_TRUNCATED'), false);
});

test('project-scoped health keeps real orphan drift without fabricating a late-page claim mismatch', () => {
  const repo = createRepo('project-aggregate-mixed-late-health');
  for (let index = 0; index < 105; index += 1) {
    seedHealthTask(`task-health-mixed-filler-${index}`, `DVF-HEALTH-MIXED-FILLER-${index}`);
  }
  const claimedTask = seedHealthTask('task-health-mixed-late-claimed', 'DVF-HEALTH-MIXED-LATE-CLAIMED', {
    workspaceId: 'ws-health-mixed-late-claimed',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  seedHealthExecution('exec-health-mixed-late-claimed', claimedTask.id, 'ws-health-mixed-late-claimed');
  const orphanTask = seedHealthTask('task-health-mixed-orphan', 'DVF-HEALTH-MIXED-ORPHAN');
  seedHealthExecution('exec-health-mixed-orphan', orphanTask.id, 'ws-health-mixed-orphan');

  const before = JSON.stringify(queryExecutionSessions({ projectId: 'project-health', status: 'active', limit: 500 }));
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health' });
  const after = JSON.stringify(queryExecutionSessions({ projectId: 'project-health', status: 'active', limit: 500 }));
  const orphanDrift = health.drift.filter((entry: any) => entry.code === 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM');

  assert.equal(orphanDrift.some((entry: any) => entry.executionSessionIds?.includes('exec-health-mixed-late-claimed')), false);
  assert.equal(orphanDrift.some((entry: any) => entry.executionSessionIds?.includes('exec-health-mixed-orphan')), true);
  assert.equal(after, before);
});

test('unresolved task selector is blocked instead of represented as idle', () => {
  const repo = createRepo('missing-task-health');
  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { projectId: 'project-health', taskId: 'DVF-MISSING' });
  assert.equal(health.scope, 'task');
  assert.equal(health.status, 'blocked');
  assert.equal(health.drift[0].code, 'TASK_SELECTOR_NOT_FOUND');
});

test('task health classifies a clean claimless active row as safe orphan debt', () => {
  const repo = createRepo('task-health-safe-orphan');
  const task = seedHealthTask('task-health-safe-orphan', 'DVF-HEALTH-SAFE-ORPHAN');
  const workspace = createHealthWorkspace(repo, 'task-health-safe-orphan-session', task.displayId);
  const session = seedHealthExecution('exec-health-safe-orphan', task.id, workspace.workspaceId);

  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.id });
  assert.equal(health.authority.classification, 'safe-orphan');
  assert.equal(health.status, 'idle');
  assert.equal(health.hardBlockers.includes('SAFE_ORPHAN_EXECUTION'), false);
  assert.equal(health.drift.some((entry: any) => entry.code === 'SAFE_ORPHAN_EXECUTION' && entry.severity === 'debt'), true);
  retireHealthWorkspace(session.id, workspace.workspaceId);
});

test('task health keeps running durable work as a hard concurrency blocker after claim loss', () => {
  const repo = createRepo('task-health-live-durable');
  const task = seedHealthTask('task-health-live-durable', 'DVF-HEALTH-LIVE-DURABLE');
  const workspace = createHealthWorkspace(repo, 'task-health-live-durable-session', task.displayId);
  const session = seedHealthExecution('exec-health-live-durable', task.id, workspace.workspaceId);
  checkpoints.recordExecutionPendingOperationReference(session.id, {
    operationId: 'job-health-live-durable',
    evidenceId: 'evidence-health-live-durable',
    kind: 'run_project_command',
    status: 'running',
  });

  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.id });
  assert.equal(health.authority.classification, 'live-durable-operation');
  assert.equal(health.status, 'blocked');
  assert.equal(health.hardBlockers.includes('LIVE_DURABLE_OPERATION'), true);
  assert.equal(health.authority.operations.restart.hardBlocked, true);
  checkpoints.reconcileExecutionPendingOperationReference(session.id, 'job-health-live-durable');
  retireHealthWorkspace(session.id, workspace.workspaceId);
});

test('task health preserves claimless dirty workspace as recoverable WIP without fabricating live authority', () => {
  const repo = createRepo('task-health-recoverable-wip');
  const task = seedHealthTask('task-health-recoverable-wip', 'DVF-HEALTH-RECOVERABLE-WIP');
  const workspace = createHealthWorkspace(repo, 'task-health-recoverable-wip-session', task.displayId);
  const session = seedHealthExecution('exec-health-recoverable-wip', task.id, workspace.workspaceId);
  fs.writeFileSync(path.join(workspace.root, 'base.txt'), 'recoverable wip\n', 'utf8');

  const health: any = getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.id });
  assert.equal(health.authority.classification, 'recoverable-wip');
  assert.equal(health.status, 'idle');
  assert.equal(health.hardBlockers.includes('ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM'), false);
  assert.equal(health.authority.operations.cleanup.hardBlocked, true);
  assert.equal(health.drift.some((entry: any) => entry.code === 'ACTIONABLE_WIP_WITHOUT_ACTIVE_CLAIM' && entry.severity === 'debt'), true);
  git(workspace.root, ['restore', '--', 'base.txt']);
  retireHealthWorkspace(session.id, workspace.workspaceId);
});

test('task health is read-only across repeated orphan diagnostics', () => {
  const repo = createRepo('readonly-task-health');
  const task = seedHealthTask('task-health-readonly', 'DVF-HEALTH-READONLY');
  seedHealthExecution('exec-health-readonly', task.id, 'ws-health-readonly');
  const before = JSON.stringify(queryExecutionSessions({ taskId: task.id, limit: 20 }));
  getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.id });
  getChatGptHarnessHealthSnapshot(stateFor(repo), { taskId: task.id });
  const after = JSON.stringify(queryExecutionSessions({ taskId: task.id, limit: 20 }));
  assert.equal(after, before);
});


test('workflow health exposes bounded OpenAI tunnel supervisor evidence', () => {
  const repo = createRepo('tunnel-evidence');
  const previousAppRoot = process.env.DEVFLOW_APP_ROOT;
  const runtimeRoot = path.join(tempRoot, 'tunnel-evidence-runtime');
  const runtimeDir = path.join(runtimeRoot, '.devflow');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'supervisor-state.json'), JSON.stringify({
    version: 2,
    supervisor: 'start-all',
    mode: 'all',
    shuttingDown: false,
    startedAt: '2026-08-16T00:00:00.000Z',
    updatedAt: '2026-08-16T00:02:00.000Z',
    processes: {
      server: { label: 'server', status: 'running', pid: 100, restartAttempt: 0 },
      tunnel: { label: 'tunnel', status: 'running', restartAttempt: 0 },
    },
    tunnelHealth: {
      status: 'degraded',
      lastCheckedAt: '2026-08-16T00:02:00.000Z',
      lastFailureAt: '2026-08-16T00:02:00.000Z',
      lastErrorClass: 'tunnel-client',
      lastErrorCode: 'TUNNEL_HEALTH_DEGRADED',
      message: 'OpenAI tunnel runtime is degraded.',
    },
  }), 'utf8');
  process.env.DEVFLOW_APP_ROOT = runtimeRoot;
  try {
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.status, 'degraded');
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.lastErrorClass, 'tunnel-client');
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.lastErrorCode, 'TUNNEL_HEALTH_DEGRADED');
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.pressure, undefined);
    assert.equal(full.diagnostics.runtimeSupervisor.tunnel.recentFailures, undefined);
    assert.equal(compact.runtime.supervisor.tunnelStatus, 'degraded');
  } finally {
    if (previousAppRoot === undefined) delete process.env.DEVFLOW_APP_ROOT;
    else process.env.DEVFLOW_APP_ROOT = previousAppRoot;
  }
});

test('getWorkflowHealth reports fallback search backend when ripgrep is unavailable', () => {
  const repo = createRepo('search-backend');
  const previous = {
    path: process.env.PATH,
    appRoot: process.env.DEVFLOW_APP_ROOT,
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
  };
  process.env.PATH = '';
  process.env.DEVFLOW_APP_ROOT = path.join(repo, 'missing-app-root');
  process.env.LOCALAPPDATA = path.join(repo, 'missing-local-app-data');
  process.env.ProgramFiles = path.join(repo, 'missing-program-files');
  try {
    const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    assert.equal(result.capabilities.search.backend, 'fallback');
    assert.equal(result.capabilities.search.fallbackAvailable, true);
  } finally {
    process.env.PATH = previous.path;
    if (previous.appRoot === undefined) delete process.env.DEVFLOW_APP_ROOT; else process.env.DEVFLOW_APP_ROOT = previous.appRoot;
    if (previous.localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.localAppData;
    if (previous.programFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previous.programFiles;
  }
});

test('getWorkflowHealth warns for a dirty repo', () => {
  const repo = createRepo('dirty');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.git.clean, false);
  assert.match(result.recommendations.join('\n'), /Working tree/);
});

test('getWorkflowHealth blocks a real unresolved merge and recovers after abort', () => {
  const repo = createRepo('merge-conflict');
  const baseBranch = git(repo, ['branch', '--show-current']);

  git(repo, ['checkout', '-b', 'conflicting-side']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'side\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'side change']);

  git(repo, ['checkout', baseBranch]);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base branch\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'base change']);

  const merge = spawnSync('git', ['merge', 'conflicting-side'], { cwd: repo, encoding: 'utf8', shell: false });
  assert.notEqual(merge.status, 0, 'fixture must create a real merge conflict');

  const blocked = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'error');
  assert.equal(blocked.git.operation.blocked, true);
  assert.equal(blocked.git.operation.code, 'GIT_OPERATION_IN_PROGRESS');
  assert.equal(blocked.git.operation.kind, 'merge');
  assert.equal(blocked.git.operation.unmergedPathCount, 1);
  assert.deepEqual(blocked.git.operation.unmergedPaths, ['base.txt']);
  assert.match(blocked.recommendations.join('\n'), /do not start unrelated write\/integration work/i);

  git(repo, ['merge', '--abort']);
  const recovered = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(recovered.ok, true);
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.git.operation.blocked, false);
  assert.equal(recovered.git.operation.unmergedPathCount, 0);
});

test('getWorkflowHealth detects rebase, cherry-pick, and revert operation markers', () => {
  const cases = [
    { kind: 'rebase', marker: 'rebase-merge', directory: true },
    { kind: 'cherry-pick', marker: 'CHERRY_PICK_HEAD', directory: false },
    { kind: 'revert', marker: 'REVERT_HEAD', directory: false },
  ];

  for (const fixture of cases) {
    const repo = createRepo(`operation-${fixture.kind}`);
    const markerPath = path.resolve(repo, git(repo, ['rev-parse', '--git-path', fixture.marker]));
    if (fixture.directory) fs.mkdirSync(markerPath, { recursive: true });
    else fs.writeFileSync(markerPath, `${git(repo, ['rev-parse', 'HEAD'])}\n`);

    const blocked = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    assert.equal(blocked.status, 'error', fixture.kind);
    assert.equal(blocked.git.operation.blocked, true, fixture.kind);
    assert.equal(blocked.git.operation.kind, fixture.kind, fixture.kind);
    assert.equal(blocked.git.operation.unmergedPathCount, 0, fixture.kind);

    fs.rmSync(markerPath, { recursive: true, force: true });
  }
});


test('getWorkflowHealth exposes phase timings without caching project git state', () => {
  const repo = createRepo('phase-freshness');
  const clean = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(typeof clean.performance.totalMs, 'number');
  assert.equal(typeof clean.performance.phases.diagnosticsMs, 'number');
  assert.equal(typeof clean.performance.phases.gitMs, 'number');

  fs.writeFileSync(path.join(repo, 'fresh-dirty.txt'), 'dirty now\n');
  const dirty = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(dirty.git.clean, false);
  assert.match(dirty.recommendations.join('\n'), /Working tree/);
});

test('getWorkflowHealth groups failed tool jobs by tool name', () => {
  const repo = createRepo('failed-tool-jobs');
  createJob('job-health-failed-1', 'run_project_command', { command: 'verify' }, `repo:${repo}`);
  updateJobStatus('job-health-failed-1', {
    status: 'failed',
    failureSummary: 'verify failed: lint error',
  });

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.diagnostics.failedJobs > 0, true);
  assert.equal(result.diagnostics.failedJobGroups[0].toolName, 'run_project_command');
  assert.equal(result.diagnostics.failedJobGroups[0].count >= 1, true);
  assert.match(result.recommendations.join('\n'), /run_project_command/);
});

test('workflow health groups failed durable jobs by existing recovery category and strategy without mutating them', () => {
  const repo = createRepo('failed-tool-recovery-policy');
  const jobs = [
    { id: 'job-health-policy-fallback', status: 'failed', code: 'SEARCH_BACKEND_UNAVAILABLE', summary: 'search backend unavailable' },
    { id: 'job-health-policy-invalid', status: 'failed', code: 'INVALID_ARGS', summary: 'invalid request' },
    { id: 'job-health-policy-timeout', status: 'timed_out', code: undefined, summary: 'timed out' },
    { id: 'job-health-policy-unknown', status: 'failed', code: 'SOMETHING_NEW', summary: 'unknown structured failure' },
    { id: 'job-health-policy-prose-only', status: 'failed', code: undefined, summary: 'SEARCH_BACKEND_UNAVAILABLE appears only in prose' },
  ] as const;

  for (const job of jobs) {
    createJob(job.id, 'search_local_files', { query: job.id }, `repo:${repo}`);
    if (job.code) writeJobResult(job.id, { error: { code: job.code } });
    updateJobStatus(job.id, { status: job.status, failureSummary: job.summary });
  }
  const beforeStatuses = jobs.map((job) => getJob(job.id)?.status);

  const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' });
  const groups = full.diagnostics.failedJobGroups.filter((group: any) => group.toolName === 'search_local_files');
  const strategies = new Set(groups.map((group: any) => `${group.recoveryCategory}:${group.recoveryStrategy}`));
  assert.equal(strategies.has('automatic:fallback-search'), true);
  assert.equal(strategies.has('automatic:narrow-scope-or-increase-timeout'), true);
  assert.equal(strategies.has('terminal:stop'), true);

  const examples = groups.flatMap((group: any) => group.examples || []);
  const fallback = examples.find((example: any) => example.jobId === 'job-health-policy-fallback');
  assert.equal(fallback?.errorCode, 'SEARCH_BACKEND_UNAVAILABLE');
  assert.equal(fallback?.recovery?.strategy, 'fallback-search');
  assert.equal(fallback?.recoveryClassification, getJob('job-health-policy-fallback')?.recoveryClassification);
  const timeout = examples.find((example: any) => example.jobId === 'job-health-policy-timeout');
  assert.equal(timeout?.errorCode, 'JOB_TIMED_OUT');
  assert.equal(timeout?.recovery?.strategy, 'narrow-scope-or-increase-timeout');
  const proseOnly = examples.find((example: any) => example.jobId === 'job-health-policy-prose-only');
  assert.equal(proseOnly?.errorCode, undefined);
  assert.equal(proseOnly?.recovery?.category, 'terminal');
  assert.equal(proseOnly?.recovery?.strategy, 'stop');
  assert.deepEqual(jobs.map((job) => getJob(job.id)?.status), beforeStatuses, 'health inspection must not mutate jobs');

  const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' });
  const compactGroups = compact.failures.groups.filter((group: any) => group.toolName === 'search_local_files');
  assert.equal(compactGroups.some((group: any) => group.recoveryStrategy === 'fallback-search'), true);
  assert.equal(compactGroups.every((group: any) => !('examples' in group)), true);
});

test('workflow health exposes durable stale job state even when no in-memory runner owns it', () => {
  const repo = createRepo('durable-job-health');
  const jobId = 'job-health-stale-durable';
  createJob(jobId, 'search_local_files', { query: 'stale' }, `repo:${repo}`);
  assert.ok(claimJob(jobId, 'dead-worker', 1_000, Date.now() - 10_000));

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.diagnostics.durableJobs.staleRunning >= 1, true);
  assert.equal(result.diagnostics.durableJobs.running >= 1, true);
  assert.match(result.recommendations.join('\n'), /stale MCP tool job lease/i);
});

test('workflow health publishes one regression event for a changed warning signature without refetch loops', () => {
  const repo = createRepo('health-event-dedup');
  const jobId = `job-health-event-${Date.now()}`;
  createJob(jobId, 'search_local_files', { query: 'event-dedup' }, `repo:${repo}`);
  assert.ok(claimJob(jobId, 'dead-worker-health-event', 1_000, Date.now() - 10_000));

  const observed: any[] = [];
  const subscription = serverEvents.subscribeServerEvents((event: any) => {
    if (event.type === 'health.regression') observed.push(event);
  });
  try {
    const before = observed.length;
    const first = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    const afterFirst = observed.length;
    const second = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

    assert.equal(first.status, 'warning');
    assert.equal(second.status, 'warning');
    assert.equal(afterFirst, before + 1);
    assert.equal(observed.length, afterFirst, 'identical health refetch must not emit another regression event');
    assert.equal(observed[afterFirst - 1].status, 'warning');
  } finally {
    subscription.unsubscribe();
  }
});

test('workflow health reuses the recent-job index while reflecting incremental job status changes', () => {
  const repo = createRepo('recent-job-index');
  clearRecentJobCache();
  for (let index = 0; index < 120; index += 1) {
    const jobId = `job-health-cache-${index}`;
    createJob(jobId, 'read_local_file', { index }, `repo:${repo}`);
    updateJobStatus(jobId, { status: 'succeeded' });
  }

  const cold = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(cold.ok, true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
  for (let index = 0; index < 20; index += 1) getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);

  createJob('job-health-cache-failed', 'run_project_command', { command: 'test' }, `repo:${repo}`);
  updateJobStatus('job-health-cache-failed', { status: 'failed', failureSummary: 'synthetic failure' });
  const refreshed = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(refreshed.diagnostics.failedJobGroups.some((group: any) => group.toolName === 'run_project_command'), true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
});

test('compact workflow health warm p95 remains below the 750ms SLO with a populated job history', () => {
  const repo = createRepo('warm-benchmark');
  getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' });
  const samples: number[] = [];
  for (let index = 0; index < 24; index += 1) {
    const startedAt = performance.now();
    getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p50 = samples[Math.ceil(samples.length * 0.5) - 1];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`[health-benchmark] warm samples=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms scanCount=${getRecentJobCacheStats().diskScanCount}`);
  assert.equal(p95 <= 750, true, `expected warm p95 <= 750ms, got ${p95.toFixed(1)}ms`);
});

test('workflow health exposes bounded residual verification process debt without raw process details', () => {
  const repo = createRepo('residual-process-health');
  clearResidualVerificationProcessStateForTests();
  try {
    registerResidualVerificationProcess({
      pid: 4321,
      platform: 'win32',
      identityHash: 'health-residual-identity',
      trigger: 'timeout',
      now: Date.now() + 60_000,
      resourceEstimate: { cpuRatio: 0.4, memoryBytes: 384 * 1024 ** 2, processCount: 2 },
    });
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    assert.equal(compact.queue.residualProcessDebt.count, 1);
    assert.equal(compact.queue.residualProcessDebt.resourceEstimate.processCount, 2);
    assert.equal(full.diagnostics.residualProcessDebt.count, 1);
    assert.equal(JSON.stringify(compact.queue.residualProcessDebt).includes('4321'), false, 'health output must stay bounded and omit raw PIDs');
    assert.match(compact.recommendations.join('\n'), /Residual verification process debt/);
  } finally {
    clearResidualVerificationProcessStateForTests();
  }
});

test('workflow health distinguishes durable lease, recovery, cancellation, and fencing states', () => {
  const repo = createRepo('durable-lease-health');
  const now = Date.now();
  const suffix = path.basename(repo);

  const healthy = createJob(`job-health-healthy-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(healthy.jobId, 'health-worker', 60_000, now);

  const stale = createJob(`job-health-stale-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(stale.jobId, 'stale-worker', 1_000, now - 5_000);

  const recovered = createJob(`job-health-recovered-${suffix}`, 'run_project_command', { command: 'typecheck' }, `repo:${repo}`);
  claimJob(recovered.jobId, 'recovered-worker', 1_000, now - 5_000);
  requeueJobForRecovery(recovered.jobId, now);

  const cancelled = createJob(`job-health-cancelled-${suffix}`, 'read_local_file', {}, `repo:${repo}`);
  requestJobCancellation(cancelled.jobId, 'synthetic cancel', now);

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  const durable = result.diagnostics.durableJobs as any;
  assert.equal(durable.healthyRunning >= 1, true);
  assert.equal(durable.staleRunning >= 1, true);
  assert.equal(durable.recovered >= 1, true);
  assert.equal(durable.cancelled >= 1, true);
  assert.equal(typeof durable.detached, 'number');
  assert.equal(typeof durable.fencedLateWrites, 'number');
});

test('workflow health reports historical regressions separately from insufficient samples', () => {
  const repo = createRepo('historical-regression');
  db.prepare('DELETE FROM performance_telemetry_snapshots').run();
  clearToolCallRecords();
  const now = Date.now();
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 100,
      timestamp: now - 5_000 + index,
    });
  }
  flushPerformanceTelemetry({ now: now - 4_900, force: true });

  clearToolCallRecords();
  for (let index = 0; index < 5; index += 1) {
    recordToolCall({
      toolName: 'search_local_files',
      args: { projectId: 'project-health' },
      status: 200,
      durationMs: 130,
      timestamp: now - 100 + index,
    });
  }
  recordToolCall({
    toolName: 'read_local_file',
    args: { projectId: 'project-health' },
    status: 200,
    durationMs: 10,
    timestamp: now - 50,
  });

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', windowMs: 1_000 });
  const history = (result.diagnostics.performance as any).history;
  assert.equal(history.regressions.length, 1);
  assert.equal(history.regressions[0].toolName, 'search_local_files');
  assert.equal(history.regressions[0].deltaPercent, 30);
  assert.equal(history.insufficientSamples.some((entry: any) => entry.toolName === 'read_local_file'), true);
  assert.match(result.recommendations.join('\n'), /Historical performance regression/);
});

test('workflow health surfaces stale source with hard restart blockers separated from cleanup debt', () => {
  const repo = createRepo('runtime-source-stale-health');
  const task = seedHealthTask('task-health-restart-debt', 'DVF-HRD-1');
  const workspace = createHealthWorkspace(repo, `health-restart-debt-${path.basename(tempRoot)}`, task.displayId);
  const execution = seedHealthExecution('exec-health-restart-debt', task.id, workspace.workspaceId);
  const before = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
  assert.equal(before.runtime.sourceFreshness.code, 'current');
  const contractPath = path.join(runtimeSourceRoot, 'src', 'server', 'contracts', 'devflowContract.ts');
  fs.mkdirSync(path.dirname(contractPath), { recursive: true });
  fs.writeFileSync(contractPath, 'export const contractSurface = 2;\n');
  git(runtimeSourceRoot, ['add', 'src/server/contracts/devflowContract.ts']);
  git(runtimeSourceRoot, ['commit', '-m', 'contract surface v2']);

  try {
    const compact = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'compact' }) as any;
    const full = getWorkflowHealth(stateFor(repo), { projectId: 'project-health', responseMode: 'full' }) as any;
    assert.equal(compact.runtime.sourceFreshness.code, 'stale');
    assert.equal(compact.runtime.diagnosis.code, 'runtime-source-stale-contract-sensitive');
    assert.equal(compact.runtime.diagnosis.contractImpact.code, 'contract-sensitive');
    assert.equal(compact.runtime.diagnosis.contractImpact.matchedPaths.includes('src/server/contracts/devflowContract.ts'), true);
    assert.match(compact.runtime.diagnosis.runningToolSurfaceIdentity, /^[0-9a-f]{64}$/);
    assert.equal(compact.runtime.diagnosis.restartSafety.cleanupDebtCount >= 1, true);
    assert.equal(compact.runtime.diagnosis.restartSafety.debtReasonCodes.includes('SAFE_ORPHAN_EXECUTION'), true);
    assert.equal(full.diagnostics.runtimeSource.restartSafety.cleanupDebtCount >= 1, true);
    assert.equal(full.diagnostics.runtimeSource.diagnosis.code, 'runtime-source-stale-contract-sensitive');
    assert.equal(full.diagnostics.runtimeSource.diagnosis.contractImpact.code, 'contract-sensitive');
    assert.equal(full.diagnostics.runtimeSource.diagnosis.contractImpact.matchedPaths.includes('src/server/contracts/devflowContract.ts'), true);
    assert.equal(full.diagnostics.runtimeSource.diagnosis.restartSafety.cleanupDebt.some((entry: any) =>
      entry.executionSessionId === execution.id && entry.classification === 'safe-orphan'), true);
    assert.equal(full.diagnostics.runtimeSource.diagnosis.restartSafety.active.some((entry: any) =>
      entry.executionSessionId === execution.id), false);
    assert.notEqual(compact.runtime.sourceFreshness.loadedRevision, compact.runtime.sourceFreshness.currentRevision);
    assert.match(compact.recommendations.join('\n'), /runtime source|restart/i);
    assert.match(compact.recommendations.join('\n'), /cleanup debt|cleanup_orphan_executions/i);
  } finally {
    retireHealthWorkspace(execution.id, workspace.workspaceId);
  }
});
