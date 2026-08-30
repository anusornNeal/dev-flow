import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-identity-'));
const runtimeSourceRoot = path.join(tempRoot, 'runtime-source');
fs.mkdirSync(runtimeSourceRoot, { recursive: true });
function runtimeGit(args: string[]) {
  const result = spawnSync('git', args, { cwd: runtimeSourceRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

runtimeGit(['init']);
runtimeGit(['config', 'user.name', 'DevFlow Test']);
runtimeGit(['config', 'user.email', 'devflow@example.test']);
fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source v1\n');
runtimeGit(['add', '.']);
runtimeGit(['commit', '-m', 'runtime source v1']);
runtimeGit(['branch', '-M', 'develop']);
process.env.DEVFLOW_RUNTIME_SOURCE_ROOT = runtimeSourceRoot;
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getTask, saveTask } = await import('../../src/server/repositories/taskRepository.js');
const sessionWorkspaces = await import('../../src/server/services/sessionWorkspaceService.js');
createProject({
  id: 'project-runtime-source',
  name: 'Runtime Source Fixture',
  repoUrl: 'https://example.test/runtime-source.git',
  localPath: runtimeSourceRoot,
  taskIdPrefix: 'RT',
} as any);
const { DEVFLOW_CONTRACT_VERSION } = await import('../../src/server/contracts/devflowContract.js');
const { getDevFlowDiagnostics } = await import('../../src/server/services/mcpToolMonitor.js');
const { getRuntimeRestartSafety } = await import('../../src/server/services/runtimeIdentityService.js');
const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');
const executionSessions = await import('../../src/server/services/executionSessionService.js');
const taskClaims = await import('../../src/server/services/taskClaimService.js');
const { listExecutionSessionsForTask } = await import('../../src/server/repositories/executionSessionRepository.js');
const { recordExecutionPendingOperationReference, reconcileExecutionPendingOperationReference } = await import('../../src/server/services/executionCheckpointService.js');

function seedRuntimeTask(id: string, displayId: string, status = 'done') {
  const now = new Date().toISOString();
  saveTask({
    id,
    displayId,
    projectId: 'project-runtime-source',
    title: 'Runtime restart fixture',
    description: 'Canonical restart authority fixture.',
    status,
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['runtime-source.txt'],
    checklist: [],
    createdAt: now,
    updatedAt: now,
    logs: [],
    bugs: [],
    images: [],
  } as any);
  return getTask(id)!;
}

test('dirty runtime source is ambiguous and does not claim a deployed revision', () => {
  fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source dirty\n');
  try {
    const diagnostics = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(diagnostics.runtime.sourceFreshness.code, 'dirty-ambiguous');
    assert.equal(diagnostics.runtimeDiagnosis.code, 'runtime-source-dirty-ambiguous');
    assert.equal(diagnostics.runtime.sourceFreshness.loadedRevision, runtimeGit(['rev-parse', 'HEAD']));
    assert.equal(diagnostics.runtime.sourceFreshness.currentRevision, runtimeGit(['rev-parse', 'HEAD']));
    assert.equal(diagnostics.runtime.sourceFreshness.currentSourceDirty, true);
  } finally {
    runtimeGit(['checkout', '--', 'runtime-source.txt']);
  }
});

test('clean commit mismatch with the same Git tree is content-equivalent and requires no restart', () => {
  const originalHead = runtimeGit(['rev-parse', 'HEAD']);
  const originalTree = runtimeGit(['rev-parse', 'HEAD^{tree}']);
  try {
    runtimeGit(['commit', '--allow-empty', '-m', 'metadata-only runtime source commit']);
    const diagnostics = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.notEqual(diagnostics.runtime.sourceFreshness.currentRevision, originalHead);
    assert.equal(diagnostics.runtime.sourceFreshness.code, 'content-equivalent');
    assert.equal(diagnostics.runtime.sourceFreshness.contentEquivalent, true);
    assert.equal(diagnostics.runtime.sourceFreshness.loadedTreeId, originalTree);
    assert.equal(diagnostics.runtime.sourceFreshness.currentTreeId, originalTree);
    assert.notEqual(diagnostics.runtimeDiagnosis?.code, 'runtime-source-stale');
  } finally {
    runtimeGit(['reset', '--hard', originalHead]);
  }
});

test('stale runtime classifies only authoritative contract revision gaps as tool-surface sensitive and clears after restart', () => {
  const originalHead = runtimeGit(['rev-parse', 'HEAD']);
  try {
    const docsPath = path.join(runtimeSourceRoot, 'docs', 'runtime-note.md');
    fs.mkdirSync(path.dirname(docsPath), { recursive: true });
    fs.writeFileSync(docsPath, 'ui/docs only\n', 'utf8');
    runtimeGit(['add', 'docs/runtime-note.md']);
    runtimeGit(['commit', '-m', 'docs only runtime gap']);
    const docsOnly = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(docsOnly.runtimeDiagnosis.code, 'runtime-source-stale');
    assert.equal(docsOnly.runtimeDiagnosis.contractImpact.code, 'none');
    assert.deepEqual(docsOnly.runtimeDiagnosis.contractImpact.matchedPaths, []);
    assert.equal(docsOnly.runtimeDiagnosis.contractImpact.changedPaths.includes('docs/runtime-note.md'), true);

    runtimeGit(['reset', '--hard', originalHead]);
    const contractRelativePath = 'src/server/contracts/devflowContract.ts';
    const contractPath = path.join(runtimeSourceRoot, ...contractRelativePath.split('/'));
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, 'export const fixtureContract = 2;\n', 'utf8');
    runtimeGit(['add', contractRelativePath]);
    runtimeGit(['commit', '-m', 'contract sensitive runtime gap']);
    const contractHead = runtimeGit(['rev-parse', 'HEAD']);
    const impacted = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(impacted.runtimeDiagnosis.code, 'runtime-source-stale-contract-sensitive');
    assert.equal(impacted.runtimeDiagnosis.contractImpact.code, 'contract-sensitive');
    assert.equal(impacted.runtimeDiagnosis.contractImpact.loadedRevision, originalHead);
    assert.equal(impacted.runtimeDiagnosis.contractImpact.currentRevision, contractHead);
    assert.equal(impacted.runtimeDiagnosis.contractImpact.matchedPaths.includes(contractRelativePath), true);
    assert.equal(impacted.runtimeDiagnosis.runningToolSurfaceIdentity, impacted.runtime.toolSurfaceIdentity);
    assert.match(impacted.runtimeDiagnosis.runningToolSurfaceIdentity, /^[0-9a-f]{64}$/);
    assert.match(impacted.runtimeDiagnosis.nextAction, /guarded|restart|reconnect|advertised/i);

    const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-contract-sensitive-restart-'));
    const code = [
      `process.env.DEVFLOW_APP_ROOT=${JSON.stringify(childRoot)};`,
      `process.env.DEVFLOW_DB_PATH=${JSON.stringify(path.join(childRoot, 'devflow.db'))};`,
      `process.env.DEVFLOW_JOBS_DIR=${JSON.stringify(path.join(childRoot, 'jobs'))};`,
      `process.env.DEVFLOW_RUNTIME_SOURCE_ROOT=${JSON.stringify(runtimeSourceRoot)};`,
      `const migrations=await import('./src/db/migrations/index.js');`,
      `migrations.executeAllMigrations();`,
      `const monitor=await import('./src/server/services/mcpToolMonitor.js');`,
      `const diagnostics=monitor.getDevFlowDiagnostics({supervisorState:null});`,
      `console.log(JSON.stringify({source:diagnostics.runtime.sourceFreshness, diagnosis:diagnostics.runtimeDiagnosis?.code || null}));`,
    ].join('');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const restarted = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1) || '{}');
    assert.equal(restarted.source.code, 'current');
    assert.equal(restarted.source.loadedRevision, contractHead);
    assert.equal(restarted.diagnosis, null);
  } finally {
    runtimeGit(['reset', '--hard', originalHead]);
  }
});

test('restart safety demotes terminal invalid workspace ambiguity to cleanup debt without weakening valid-workspace ambiguity', () => {
  const task = seedRuntimeTask('task-runtime-terminal-invalid', 'RT-0099', 'done');
  const first = executionSessions.createExecutionSession({
    projectId: 'project-runtime-source',
    taskId: task.id,
    workspaceId: 'ws-terminal-invalid-a',
    repoRoot: runtimeSourceRoot,
    branch: 'develop',
  });
  const second = executionSessions.createExecutionSession({
    projectId: 'project-runtime-source',
    taskId: task.id,
    workspaceId: 'ws-terminal-invalid-b',
    repoRoot: runtimeSourceRoot,
    branch: 'develop',
  });

  try {
    const safety = getRuntimeRestartSafety();
    assert.equal(safety.blocked, false, 'terminal claimless invalid workspace history without durable operations is cleanup debt');
    assert.equal(safety.active.some((entry: any) => entry.executionSessionId === first.id || entry.executionSessionId === second.id), false);
    for (const execution of [first, second]) {
      const debt = safety.cleanupDebt.find((entry: any) => entry.executionSessionId === execution.id);
      assert.ok(debt, `expected cleanup debt for ${execution.id}`);
      assert.equal(debt.classification, 'invalid-workspace-authority');
      assert.ok(debt.reasonCodes?.includes('WORKSPACE_AUTHORITY_INVALID_RESTART_DEBT'));
      assert.ok(debt.reasonCodes?.includes('MULTIPLE_ACTIVE_EXECUTIONS'));
    }
  } finally {
    executionSessions.completeExecutionSession(first.id);
    executionSessions.completeExecutionSession(second.id);
  }
});

test('restart safety ignores safe-orphan changedFiles, but blocks live durable and live ownership authority', () => {
  const task = seedRuntimeTask('task-runtime-source-active', 'RT-0001');
  const workspace = sessionWorkspaces.createOrReuseSessionWorkspace(
    { id: 'project-runtime-source', localPath: runtimeSourceRoot },
    'runtime-source-restart-authority',
    { taskDisplayId: task.displayId },
  );
  const execution = executionSessions.createExecutionSession({
    projectId: 'project-runtime-source',
    taskId: task.id,
    workspaceId: workspace.workspaceId,
    repoRoot: workspace.root,
    branch: workspace.branch,
  });
  executionSessions.recordExecutionLifecycleTransition(execution.id, {
    toStage: 'context-ready',
    reasonCode: 'runtime-source-test-context-ready',
    evidence: { id: 'runtime-source-test-context-ready', kind: 'context', status: 'completed' },
  });
  executionSessions.recordExecutionLifecycleTransition(execution.id, {
    toStage: 'implementing',
    reasonCode: 'runtime-source-test-implementing',
    evidence: { id: 'runtime-source-test-implementing', kind: 'mutation', status: 'completed' },
  });

  const originalHead = runtimeGit(['rev-parse', 'HEAD']);
  try {
    const before = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(before.runtime.sourceFreshness.code, 'current');
    fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source v2\n');
    runtimeGit(['add', 'runtime-source.txt']);
    runtimeGit(['commit', '-m', 'runtime source v2']);
    const currentHead = runtimeGit(['rev-parse', 'HEAD']);

    executionSessions.updateExecutionSessionProgress(execution.id, { changedFiles: ['runtime-source.txt'] });
    const stale = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(stale.runtimeDiagnosis.code, 'runtime-source-stale');
    assert.equal(stale.runtime.sourceFreshness.currentRevision, currentHead);
    assert.equal(stale.runtimeDiagnosis.restartSafety.blocked, false, 'safe orphan metadata must not become live authority because changedFiles is non-empty');
    assert.equal(stale.runtimeDiagnosis.restartSafety.active.some((entry: any) => entry.executionSessionId === execution.id), false);
    assert.equal(stale.runtimeDiagnosis.restartSafety.cleanupDebt.some((entry: any) =>
      entry.executionSessionId === execution.id
      && entry.classification === 'safe-orphan'
      && entry.reasonCodes?.includes('SAFE_ORPHAN_EXECUTION')), true);

    fs.writeFileSync(path.join(workspace.root, 'runtime-source.txt'), 'recoverable orphan wip\n', 'utf8');
    const recoverableBlocked = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(recoverableBlocked.runtimeDiagnosis.restartSafety.blocked, true, 'claimless dirty/unique workspace WIP must remain a restart blocker');
    assert.equal(recoverableBlocked.runtimeDiagnosis.restartSafety.active.some((entry: any) =>
      entry.executionSessionId === execution.id
      && entry.classification === 'recoverable-wip'
      && entry.reasonCodes?.includes('RECOVERABLE_WIP_RESTART_FENCE')), true);
    spawnSync('git', ['restore', '--', 'runtime-source.txt'], { cwd: workspace.root, encoding: 'utf8', shell: false });

    const duplicate = executionSessions.createExecutionSession({
      projectId: 'project-runtime-source',
      taskId: task.id,
      workspaceId: workspace.workspaceId,
      repoRoot: workspace.root,
      branch: workspace.branch,
    });
    const ambiguous = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(ambiguous.runtimeDiagnosis.restartSafety.blocked, true);
    assert.equal(ambiguous.runtimeDiagnosis.restartSafety.active.some((entry: any) =>
      entry.reasonCodes?.includes('MULTIPLE_ACTIVE_EXECUTIONS')), true);
    executionSessions.completeExecutionSession(duplicate.id);

    recordExecutionPendingOperationReference(execution.id, {
      operationId: 'runtime-pending-op-1', evidenceId: 'runtime-pending-evidence-1', kind: 'mutation', status: 'running',
    });
    const pendingBlocked = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(pendingBlocked.runtimeDiagnosis.restartSafety.blocked, true);
    assert.equal(pendingBlocked.runtimeDiagnosis.restartSafety.active.some((entry: any) =>
      entry.executionSessionId === execution.id
      && entry.reasonCodes?.includes('LIVE_DURABLE_OPERATION')
      && entry.pendingOperationIds?.includes('runtime-pending-op-1')), true);
    reconcileExecutionPendingOperationReference(execution.id, 'runtime-pending-op-1');

    const liveTask = seedRuntimeTask('task-runtime-source-live', 'RT-0002', 'todo');
    const claimedLive = taskClaims.claimTaskForSession(liveTask.id, {
      sessionId: 'runtime-live-claim',
      ownerKind: 'chat',
      ownerLabel: 'Runtime fault test',
    });
    const liveExecution = listExecutionSessionsForTask(liveTask.id).find((entry: any) => entry.status === 'active')!;
    const liveWorkspace = sessionWorkspaces.resolveSessionWorkspace(claimedLive.claim.workspaceId)!;
    fs.writeFileSync(path.join(liveWorkspace.root, 'runtime-source.txt'), 'live workspace wip\n', 'utf8');
    executionSessions.updateExecutionSessionProgress(liveExecution.id, { changedFiles: ['runtime-source.txt'] });
    const liveBlocked = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
    assert.equal(liveBlocked.runtimeDiagnosis.restartSafety.blocked, true, 'live claim plus dirty WIP stays conservative because restart-interruption safety is not proven');
    assert.equal(liveBlocked.runtimeDiagnosis.restartSafety.active.some((entry: any) =>
      entry.executionSessionId === liveExecution.id && entry.reasonCodes?.includes('LIVE_AUTHORITATIVE_WORK')), true);
    spawnSync('git', ['restore', '--', 'runtime-source.txt'], { cwd: liveWorkspace.root, encoding: 'utf8', shell: false });
    taskClaims.releaseTaskClaim(liveTask.id, { sessionId: 'runtime-live-claim', nextStatus: 'todo' });
    try { sessionWorkspaces.cleanupSessionWorkspace(liveWorkspace.workspaceId); } catch {}

    const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-source-restart-'));
    const code = [
      `process.env.DEVFLOW_APP_ROOT=${JSON.stringify(childRoot)};`,
      `process.env.DEVFLOW_DB_PATH=${JSON.stringify(path.join(childRoot, 'devflow.db'))};`,
      `process.env.DEVFLOW_JOBS_DIR=${JSON.stringify(path.join(childRoot, 'jobs'))};`,
      `process.env.DEVFLOW_RUNTIME_SOURCE_ROOT=${JSON.stringify(runtimeSourceRoot)};`,
      `const migrations=await import('./src/db/migrations/index.js');`,
      `migrations.executeAllMigrations();`,
      `const monitor=await import('./src/server/services/mcpToolMonitor.js');`,
      `const diagnostics=monitor.getDevFlowDiagnostics({supervisorState:null});`,
      `console.log(JSON.stringify({source:diagnostics.runtime.sourceFreshness, diagnosis:diagnostics.runtimeDiagnosis?.code || null}));`,
    ].join('');
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { ...process.env },
      encoding: 'utf8',
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const restarted = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1) || '{}');
    assert.equal(restarted.source.code, 'current');
    assert.equal(restarted.source.loadedRevision, currentHead);
    assert.equal(restarted.source.currentRevision, currentHead);
    assert.equal(restarted.diagnosis, null);
  } finally {
    const finalTask = getTask(task.id)!;
    finalTask.claim = undefined;
    finalTask.status = 'done';
    saveTask(finalTask);
    try { spawnSync('git', ['restore', '--', 'runtime-source.txt'], { cwd: workspace.root, encoding: 'utf8', shell: false }); } catch {}
    executionSessions.completeExecutionSession(execution.id);
    try { sessionWorkspaces.cleanupSessionWorkspace(workspace.workspaceId); } catch {}
    runtimeGit(['reset', '--hard', originalHead]);
  }
});

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerDevFlowRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
    restartProcess: () => {},
  } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind runtime diagnostics test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('runtime identity is stable for one process and exposed in compact diagnostics', () => {
  const first = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const second = getDevFlowDiagnostics({ supervisorState: null } as any) as any;

  assert.match(first.runtime.runtimeInstanceId, /^[0-9a-f-]{20,}$/i);
  assert.equal(first.runtime.runtimeInstanceId, second.runtime.runtimeInstanceId);
  assert.equal(first.runtime.runtimeStartedAt, second.runtime.runtimeStartedAt);
  assert.equal(first.runtime.contractVersion, DEVFLOW_CONTRACT_VERSION);
  assert.equal(first.runtime.loadedRevision, runtimeGit(['rev-parse', 'HEAD']));
  assert.equal(first.runtime.sourceFreshness.code, 'current');
  assert.equal(first.runtime.sourceFreshness.currentSourceDirty, false);
  assert.ok(Array.isArray(first.runtime.transport));
  assert.deepEqual(first.runtime.transport, ['streamable-http', 'legacy-sse']);
});

test('runtime transport metadata reports both migration transports after the /mcp cutover', () => {
  const diagnostics = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  assert.deepEqual(diagnostics.runtime.transport, ['streamable-http', 'legacy-sse']);
});

test('runtime diagnostics expose tool-surface identity and distinguish schema drift from a pure restart', () => {
  const current = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  assert.equal(typeof current.runtime.toolSurfaceIdentity, 'string');
  assert.match(current.runtime.toolSurfaceIdentity, /^[0-9a-f]{64}$/);

  const restarted = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: 'previous-runtime',
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(restarted.runtimeDiagnosis.code, 'runtime-restarted');

  const schemaChanged = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: 'previous-runtime',
      toolSurfaceIdentity: '0'.repeat(64),
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(schemaChanged.runtimeDiagnosis.code, 'tool-surface-changed');
  assert.match(schemaChanged.runtimeDiagnosis.nextAction, /refresh|reconnect|registry/i);
});

test('recovery parity separates server readiness from client-observed MCP surface proof', () => {
  const current = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  assert.equal(current.recoveryParity.server.ready, true);
  assert.equal(current.recoveryParity.clientObserved.state, 'unknown');
  assert.equal(current.recoveryParity.endToEnd.state, 'unknown');
  assert.equal(current.recoveryParity.endToEnd.ready, null);

  const matching = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      criticalToolSchemaIdentity: current.runtime.criticalToolSchemaIdentity,
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(matching.recoveryParity.clientObserved.state, 'ready');
  assert.equal(matching.recoveryParity.clientObserved.criticalToolSchemaMatch, true);
  assert.equal(matching.recoveryParity.endToEnd.state, 'ready');
  assert.equal(matching.recoveryParity.endToEnd.ready, true);

  const staleCriticalSchema = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      criticalToolSchemaIdentity: 'f'.repeat(64),
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(staleCriticalSchema.recoveryParity.clientObserved.state, 'schema-mismatch');
  assert.equal(staleCriticalSchema.recoveryParity.clientObserved.criticalToolSchemaMatch, false);
  assert.equal(staleCriticalSchema.recoveryParity.endToEnd.state, 'not-ready');
  assert.equal(staleCriticalSchema.recoveryParity.endToEnd.ready, false);
  assert.ok(staleCriticalSchema.recoveryParity.endToEnd.reasonCodes.includes('CLIENT_TOOL_SCHEMA_MISMATCH'));
  assert.equal(staleCriticalSchema.recoveryParity.endToEnd.recoverySurface, 'get_recovery_handoff');

  const staleSurface = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolSurfaceIdentity: '0'.repeat(64),
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(staleSurface.recoveryParity.server.ready, true);
  assert.equal(staleSurface.recoveryParity.clientObserved.state, 'stale');
  assert.equal(staleSurface.recoveryParity.endToEnd.state, 'not-ready');
  assert.equal(staleSurface.recoveryParity.endToEnd.ready, false);
  assert.ok(staleSurface.recoveryParity.endToEnd.reasonCodes.includes('CLIENT_TOOL_SURFACE_MISMATCH'));
  assert.equal(staleSurface.recoveryParity.endToEnd.recoverySurface, 'get_recovery_handoff');

  const missingTools = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      toolsVisible: false,
    },
  } as any) as any;
  assert.equal(missingTools.recoveryParity.clientObserved.state, 'missing-tools');
  assert.equal(missingTools.recoveryParity.endToEnd.ready, false);
  assert.ok(missingTools.recoveryParity.endToEnd.reasonCodes.includes('CLIENT_TOOLS_NOT_VISIBLE'));
  assert.equal(missingTools.recoveryParity.endToEnd.recoverySurface, 'get_recovery_handoff');

  const missingRequiredTool = getDevFlowDiagnostics({
    supervisorState: null,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolSurfaceIdentity: current.runtime.toolSurfaceIdentity,
      toolsVisible: true,
      unavailableToolNames: ['adopt_task_execution_owned_changes'],
    },
  } as any) as any;
  assert.equal(missingRequiredTool.recoveryParity.clientObserved.state, 'missing-tools');
  assert.deepEqual(missingRequiredTool.recoveryParity.clientObserved.missingRequiredRecoveryToolNames, ['adopt_task_execution_owned_changes']);
  assert.equal(missingRequiredTool.recoveryParity.endToEnd.ready, false);
  assert.ok(missingRequiredTool.recoveryParity.endToEnd.reasonCodes.includes('CLIENT_REQUIRED_RECOVERY_TOOLS_MISSING'));
  assert.equal(missingRequiredTool.recoveryParity.endToEnd.recoverySurface, 'get_recovery_handoff');
});

test('a fresh process receives a different runtime instance id', () => {
  const parent = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const childRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runtime-identity-child-'));
  const code = [
    `process.env.DEVFLOW_APP_ROOT=${JSON.stringify(childRoot)};`,
    `process.env.DEVFLOW_DB_PATH=${JSON.stringify(path.join(childRoot, 'devflow.db'))};`,
    `process.env.DEVFLOW_JOBS_DIR=${JSON.stringify(path.join(childRoot, 'jobs'))};`,
    `const migrations=await import('./src/db/migrations/index.js');`,
    `migrations.executeAllMigrations();`,
    `const monitor=await import('./src/server/services/mcpToolMonitor.js');`,
    `console.log(monitor.getDevFlowDiagnostics({supervisorState:null}).runtime.runtimeInstanceId);`,
  ].join('');
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { ...process.env },
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr || child.stdout);
  const childId = child.stdout.trim().split(/\r?\n/).at(-1) || '';
  assert.match(childId, /^[0-9a-f-]{20,}$/i);
  assert.notEqual(childId, parent.runtime.runtimeInstanceId);
});

test('runtime diagnostics classify restart, deployment change, and likely client registry desync', () => {
  const current = getDevFlowDiagnostics({ supervisorState: null } as any) as any;
  const common = { supervisorState: null };

  const restarted = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: DEVFLOW_CONTRACT_VERSION,
      runtimeInstanceId: 'previous-runtime',
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(restarted.runtimeDiagnosis.code, 'runtime-restarted');
  assert.match(restarted.runtimeDiagnosis.nextAction, /reconnect/i);

  const deployed = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: 'older-contract',
      runtimeInstanceId: 'previous-runtime',
      toolsVisible: true,
    },
  } as any) as any;
  assert.equal(deployed.runtimeDiagnosis.code, 'deployment-changed');
  assert.match(deployed.runtimeDiagnosis.nextAction, /refresh|reconnect/i);

  const desynced = getDevFlowDiagnostics({
    ...common,
    clientState: {
      contractVersion: current.runtime.contractVersion,
      runtimeInstanceId: current.runtime.runtimeInstanceId,
      toolsVisible: false,
    },
  } as any) as any;
  assert.equal(desynced.runtimeDiagnosis.code, 'client-registry-desync');
  assert.equal(desynced.runtimeDiagnosis.recoverySurface, 'get_recovery_handoff');
  assert.match(desynced.runtimeDiagnosis.nextAction, /fresh chat|refresh|reconnect/i);
  assert.match(desynced.runtimeDiagnosis.detail, /cannot repair/i);
});

test('capabilities and diagnostics routes expose runtime identity and accept client observation hints', async () => {
  await withServer(async (baseUrl) => {
    const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
    const capabilities = await capabilitiesResponse.json() as any;
    assert.equal(capabilitiesResponse.status, 200);
    assert.equal(capabilities.contractVersion, DEVFLOW_CONTRACT_VERSION);
    assert.match(capabilities.toolSurfaceIdentity, /^[0-9a-f]{64}$/);
    assert.match(capabilities.runtimeInstanceId, /^[0-9a-f-]{20,}$/i);
    assert.equal(typeof capabilities.runtimeStartedAt, 'string');
    assert.equal(capabilities.loadedRevision, runtimeGit(['rev-parse', 'HEAD']));
    assert.equal(capabilities.sourceFreshness.code, 'current');
    assert.deepEqual(capabilities.transport, ['streamable-http', 'legacy-sse']);
    assert.equal(capabilities.modules.mcpStreamableHttp, true);
    assert.equal(capabilities.modules.mcpSse, true);
    assert.equal(capabilities.tools.some((tool: any) => tool.name === 'get_recovery_handoff'), true);

    const diagnosticsResponse = await fetch(`${baseUrl}/api/diagnostics?previousContractVersion=${encodeURIComponent(capabilities.contractVersion)}&previousRuntimeInstanceId=${encodeURIComponent(capabilities.runtimeInstanceId)}&clientToolsVisible=false`);
    const diagnostics = await diagnosticsResponse.json() as any;
    assert.equal(diagnosticsResponse.status, 200);
    assert.equal(diagnostics.runtime.runtimeInstanceId, capabilities.runtimeInstanceId);
    assert.equal(diagnostics.runtimeDiagnosis.code, 'client-registry-desync');
    assert.equal(diagnostics.runtimeDiagnosis.recoverySurface, 'get_recovery_handoff');

    const driftResponse = await fetch(`${baseUrl}/api/diagnostics?previousContractVersion=${encodeURIComponent(capabilities.contractVersion)}&previousRuntimeInstanceId=previous-runtime&previousToolSurfaceIdentity=${'0'.repeat(64)}`);
    const drift = await driftResponse.json() as any;
    assert.equal(driftResponse.status, 200);
    assert.equal(drift.runtimeDiagnosis.code, 'tool-surface-changed');
  });
});
