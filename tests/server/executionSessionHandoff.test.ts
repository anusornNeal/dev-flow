import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-session-handoff-'));
const repoRoot = path.join(tempRoot, 'repo');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 1;\n', 'utf8');
fs.writeFileSync(path.join(repoRoot, 'src', 'B.ts'), 'export const B = 1;\n', 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const sessions = await import('../../src/server/services/executionSessionService.js');
const handoff = await import('../../src/server/services/executionSessionHandoffService.js');
const checkpoints = await import('../../src/server/services/executionCheckpointService.js');

const state = { countersCache: {} } as any;
const now = new Date().toISOString();
saveTask({
  id: 'task-handoff',
  displayId: 'DVF-HANDOFF',
  title: 'Handoff fixture',
  description: 'fixture',
  projectId: 'project-handoff',
  status: 'in-progress',
  priority: 'medium',
  branch: 'develop',
  category: 'backend',
  tags: [],
  targetFiles: ['src/A.ts'],
  checklist: [
    { id: 'impl', text: 'Implement core handoff service', completed: true },
    { id: 'verify', text: 'Verify receiving-agent flow', completed: false },
  ],
  parentId: 'task-parent',
  createdAt: now,
  updatedAt: now,
  logs: [],
});

function createPreparedSession(workspaceId: string) {
  const session = sessions.createExecutionSession({
    projectId: 'project-handoff',
    taskId: 'task-handoff',
    workspaceId,
    branch: 'feature/handoff',
    repoRoot,
  });
  sessions.recordExecutionSessionEvidence(session.id, [
    { kind: 'file', path: 'src/A.ts', metadata: { symbols: ['A'] } },
    { kind: 'file', path: 'src/B.ts', metadata: { symbols: ['B'] } },
  ], { repoRoot });
  sessions.updateExecutionSessionProgress(session.id, {
    contextHandle: 'ctx-handoff',
    changedFiles: ['src/A.ts'],
    verification: [{ name: 'focused', status: 'passed', summary: 'handoff fixture green' }],
  });
  return session;
}

test('automatically checkpoints meaningful lifecycle transitions and coalesces duplicate or rapid progress', () => {
  const session = createPreparedSession('ws_checkpoint_auto');
  const transition = {
    toStage: 'context-ready' as const,
    reasonCode: 'context-ready',
    evidence: { id: 'context-auto-1', kind: 'context-bundle', status: 'completed' as const, operationId: 'op-context-auto-1' },
  };
  const first = sessions.recordExecutionLifecycleTransition(session.id, transition);
  const firstCheckpoint = checkpoints.getLatestExecutionCheckpoint(session.id)!;
  assert.equal(first.changed, true);
  assert.equal(firstCheckpoint.stage, 'context-ready');
  assert.equal(firstCheckpoint.transitionEvidenceId, first.transition.id);
  assert.equal(sessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.kind === 'checkpoint').length, 1);

  const retry = sessions.recordExecutionLifecycleTransition(session.id, transition);
  assert.equal(retry.idempotent, true);
  assert.equal(checkpoints.getLatestExecutionCheckpoint(session.id)?.id, firstCheckpoint.id);
  assert.equal(sessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.kind === 'checkpoint').length, 1);

  sessions.recordExecutionLifecycleTransition(session.id, {
    toStage: 'plan-recorded',
    reasonCode: 'plan-recorded',
    evidence: { id: 'plan-auto-1', kind: 'plan-evidence', status: 'completed', operationId: 'op-plan-auto-1' },
  });
  const refreshed = checkpoints.getLatestExecutionCheckpoint(session.id)!;
  assert.equal(refreshed.id, firstCheckpoint.id);
  assert.equal(refreshed.stage, 'plan-recorded');
  assert.equal(sessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.kind === 'checkpoint').length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(refreshed), 'utf8') < 12_000);
});

test('preserves an accepted durable operation across lost client response without replaying the mutation', () => {
  const session = createPreparedSession('ws_checkpoint_pending');
  const accepted = {
    toStage: 'context-ready' as const,
    reasonCode: 'context-after-job',
    evidence: { id: 'job-accept-evidence-1', kind: 'durable-tool-job', status: 'accepted' as const, operationId: 'job-durable-123' },
  };
  assert.throws(
    () => sessions.recordExecutionLifecycleTransition(session.id, accepted),
    (error: any) => error?.code === 'EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL',
  );

  const checkpoint = checkpoints.getLatestExecutionCheckpoint(session.id)!;
  assert.equal(checkpoint.stage, 'created');
  assert.deepEqual(checkpoint.pendingOperations.map((entry) => entry.operationId), ['job-durable-123']);
  const lifecycleBeforeResume = sessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.kind === 'lifecycle-transition').length;
  const resumed = handoff.getExecutionSessionResumeView(state, session.id, {
    repoRoot,
    workspaceId: 'ws_checkpoint_pending',
  });
  assert.equal(resumed.stage, 'created');
  assert.equal(resumed.pendingOperations[0]?.operationId, 'job-durable-123');
  assert.ok(resumed.recoveryBlockers.some((blocker: any) => blocker.code === 'PENDING_DURABLE_OPERATION' && blocker.operationId === 'job-durable-123'));
  assert.ok(resumed.warnings.some((warning: string) => /do not replay/i.test(warning)));
  assert.equal(sessions.getExecutionSessionState(session.id).evidence.filter((entry: any) => entry.kind === 'lifecycle-transition').length, lifecycleBeforeResume);

  const script = `
    const checkpoints = await import('./src/server/services/executionCheckpointService.js');
    process.stdout.write(JSON.stringify(checkpoints.getLatestExecutionCheckpoint(${JSON.stringify(session.id)})));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, DEVFLOW_DB_PATH: process.env.DEVFLOW_DB_PATH! },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const reloadedCheckpoint = JSON.parse(child.stdout);
  assert.equal(reloadedCheckpoint.stage, 'created');
  assert.equal(reloadedCheckpoint.pendingOperations[0].operationId, 'job-durable-123');

  sessions.recordExecutionLifecycleTransition(session.id, {
    ...accepted,
    evidence: { ...accepted.evidence, status: 'completed' as const },
  });
  const completed = handoff.getExecutionSessionResumeView(state, session.id, { repoRoot, workspaceId: 'ws_checkpoint_pending' });
  assert.equal(completed.stage, 'context-ready');
  assert.equal(completed.pendingOperations.length, 0);
});

test('creates a compact persisted ChatGPT→Codex handoff without source bodies or absolute workspace paths', () => {
  const session = createPreparedSession('ws_handoff_compact');
  const snapshot = handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'ChatGPT',
    toAgent: 'Codex',
    lastCompletedStage: 'implementation',
    decisions: ['Persist handoffs as revision-bound session evidence.'],
    dependencies: ['DVF-0395'],
    risks: ['Target may change before receiving agent resumes.'],
  }, { repoRoot });

  assert.match(snapshot.id, /^handoff-/);
  assert.equal(snapshot.executionSessionId, session.id);
  assert.equal(snapshot.fromAgent, 'ChatGPT');
  assert.equal(snapshot.toAgent, 'Codex');
  assert.equal(snapshot.lastCompletedStage, 'implementation');
  assert.deepEqual(snapshot.completedWork, ['Implement core handoff service']);
  assert.deepEqual(snapshot.pendingNextWork, ['Verify receiving-agent flow']);
  assert.equal(snapshot.task.displayId, 'DVF-HANDOFF');
  assert.equal(snapshot.evidence.filter((entry) => entry.kind === 'file').length, 2);
  assert.ok(snapshot.evidence.some((entry) => entry.kind === 'lifecycle-transition'));
  assert.equal(snapshot.verification.length, 1);
  assert.equal(JSON.stringify(snapshot).includes(repoRoot), false);
  assert.equal(JSON.stringify(snapshot).includes('export const A = 1'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 12_000);

  const persisted = handoff.listExecutionHandoffSnapshots(session.id);
  assert.equal(persisted[0].id, snapshot.id);
  assert.equal(persisted[0].executionSessionId, session.id);
});

test('resume view reports completed/pending work and keeps the same logical session across provider changes', () => {
  const session = createPreparedSession('ws_handoff_resume');
  const first = handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'ChatGPT',
    toAgent: 'Codex',
    lastCompletedStage: 'implementation',
    decisions: ['Use evidence references, never cached full file bodies.'],
  }, { repoRoot });

  const resumed = handoff.getExecutionSessionResumeView(state, session.id, {
    repoRoot,
    workspaceId: 'ws_handoff_resume',
    receivingAgent: 'Codex',
  });
  assert.equal(resumed.executionSessionId, session.id);
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.validity, 'valid');
  assert.equal(resumed.lastCompletedStage, 'implementation');
  assert.deepEqual(resumed.pendingNextWork, ['Verify receiving-agent flow']);
  assert.equal(resumed.handoff?.id, first.id);
  assert.equal(resumed.handoff?.toAgent, 'Codex');
  assert.equal(resumed.reusableEvidence.length, 2);
  assert.equal(resumed.staleEvidence.length, 0);

  const second = handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'Codex',
    toAgent: 'Review',
    lastCompletedStage: 'verification',
    pendingNextWork: ['Review scoped diff and evidence.'],
  }, { repoRoot });
  assert.equal(second.executionSessionId, session.id);
  assert.notEqual(second.id, first.id);
  assert.equal(handoff.getExecutionSessionResumeView(state, session.id, { repoRoot, receivingAgent: 'Review' }).executionSessionId, session.id);
});

test('marks context and verification stale when execution progress changes after the latest checkpoint', () => {
  const session = createPreparedSession('ws_checkpoint_context_stale');
  sessions.recordExecutionLifecycleTransition(session.id, {
    toStage: 'context-ready',
    reasonCode: 'context-ready',
    evidence: { id: 'context-stale-1', kind: 'context-bundle', status: 'completed' },
  });
  sessions.updateExecutionSessionProgress(session.id, {
    contextHandle: 'ctx-after-checkpoint',
    verification: [{ name: 'newer-check', status: 'passed' }],
  });

  const resumed = handoff.getExecutionSessionResumeView(state, session.id, {
    repoRoot,
    workspaceId: 'ws_checkpoint_context_stale',
  });
  assert.equal(resumed.validity, 'stale');
  assert.equal(resumed.freshness.context, 'stale');
  assert.equal(resumed.freshness.verification, 'stale');
  assert.deepEqual(resumed.contextHandleLineage, ['ctx-handoff']);
  assert.ok(resumed.recoveryBlockers.some((blocker: any) => blocker.code === 'FRESHNESS_REVALIDATION_REQUIRED'));
});

test('manual handoff enriches the automatic checkpoint while keeping it bounded and redacted', () => {
  const session = createPreparedSession('ws_checkpoint_manual_enrich');
  sessions.recordExecutionLifecycleTransition(session.id, {
    toStage: 'context-ready',
    reasonCode: 'context-ready',
    evidence: { id: 'context-manual-1', kind: 'context-bundle', status: 'completed' },
  });
  const decisions = Array.from({ length: 40 }, (_, index) => `Decision ${index}: ${repoRoot}/secret-${index}`);
  handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'ChatGPT',
    toAgent: 'Codex',
    decisions,
    risks: [`Inspect ${repoRoot}/risk without copying the workspace root.`],
  }, { repoRoot });

  const checkpoint = checkpoints.getLatestExecutionCheckpoint(session.id)!;
  assert.equal(checkpoint.stage, 'context-ready');
  assert.equal(checkpoint.decisions.length, 16);
  assert.ok(checkpoint.blockers.some((entry) => entry.includes('[workspace]/risk')));
  assert.equal(JSON.stringify(checkpoint).includes(repoRoot), false);
  assert.ok(Buffer.byteLength(JSON.stringify(checkpoint), 'utf8') < 12_000);
});

test('workspace mismatch blocks recovery without replacing the execution identity', () => {
  const session = createPreparedSession('ws_checkpoint_identity');
  sessions.recordExecutionLifecycleTransition(session.id, {
    toStage: 'context-ready',
    reasonCode: 'context-ready',
    evidence: { id: 'context-identity-1', kind: 'context-bundle', status: 'completed' },
  });
  const resumed = handoff.getExecutionSessionResumeView(state, session.id, { workspaceId: 'ws_different' });
  assert.equal(resumed.resumable, false);
  assert.equal(resumed.validity, 'workspace-mismatch');
  assert.equal(resumed.executionSessionId, session.id);
  assert.equal(resumed.identity.workspaceId, 'ws_checkpoint_identity');
  assert.ok(resumed.recoveryBlockers.some((blocker: any) => blocker.code === 'WORKSPACE_MISMATCH' && blocker.replacementExecutionAllowed === false));
});

test('stale target evidence is surfaced explicitly and requires a fresh read while unchanged evidence remains reusable', () => {
  const session = createPreparedSession('ws_handoff_stale');
  handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'ChatGPT',
    toAgent: 'Codex',
    lastCompletedStage: 'inspection',
  }, { repoRoot });

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  const resumed = handoff.getExecutionSessionResumeView(state, session.id, {
    repoRoot,
    workspaceId: 'ws_handoff_stale',
    receivingAgent: 'Codex',
  });

  assert.equal(resumed.validity, 'stale');
  assert.deepEqual(resumed.staleEvidence.map((entry: any) => entry.path), ['src/A.ts']);
  assert.deepEqual(resumed.reusableEvidence.map((entry: any) => entry.path), ['src/B.ts']);
  assert.deepEqual(resumed.requiresFreshRead, ['src/A.ts']);
  assert.ok(resumed.warnings.some((warning: string) => /fresh-read/i.test(warning)));
  assert.equal(JSON.stringify(resumed).includes('export const A = 2'), false);
});

test('terminal sessions remain reviewable but are not resumable as active work', () => {
  const session = createPreparedSession('ws_handoff_terminal');
  handoff.createExecutionHandoffSnapshot(state, session.id, {
    fromAgent: 'Codex',
    toAgent: 'Review',
    lastCompletedStage: 'verification',
  }, { repoRoot });
  sessions.completeExecutionSession(session.id, { changedFiles: ['src/A.ts'] });

  const resumed = handoff.getExecutionSessionResumeView(state, session.id, { repoRoot, receivingAgent: 'Review' });
  assert.equal(resumed.resumable, false);
  assert.equal(resumed.validity, 'terminal');
  assert.equal(resumed.handoff?.toAgent, 'Review');
  assert.ok(resumed.warnings.some((warning: string) => /terminal/i.test(warning)));
  assert.ok(resumed.recoveryBlockers.some((blocker: any) => blocker.code === 'SESSION_TERMINAL' && blocker.replacementExecutionAllowed === false));
});

test.after(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
});
