import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-execution-session-'));
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
const sessions = await import('../../src/server/services/executionSessionService.js');
const repository = await import('../../src/server/repositories/executionSessionRepository.js');

test('persists logical execution-session identity without storing the local repo path', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-session',
    workspaceId: 'ws_opaque-session-1',
    branch: 'feature/session',
    repoRoot,
  });

  assert.match(created.id, /^exec-/);
  assert.equal(created.status, 'active');
  assert.equal(created.workspaceId, 'ws_opaque-session-1');
  assert.ok(created.repoRevision);
  assert.ok(created.baseRevision);
  assert.equal('repoRoot' in created, false);
  assert.equal(JSON.stringify(created).includes(repoRoot), false);

  const reloaded = repository.getExecutionSessionById(created.id);
  assert.equal(reloaded?.id, created.id);
  assert.equal(reloaded?.workspaceId, 'ws_opaque-session-1');
  assert.equal(JSON.stringify(reloaded).includes(repoRoot), false);
});

test('survives a fresh Node process and resolves the same logical session from SQLite', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-restart',
    workspaceId: 'ws_restart',
    repoRoot,
  });
  sessions.updateExecutionSessionProgress(created.id, {
    contextHandle: 'ctx-restart',
    changedFiles: ['src/B.ts'],
    verification: [{ name: 'restart-fixture', status: 'passed' }],
  });

  const script = `
    const repo = await import('./src/server/repositories/executionSessionRepository.js');
    const session = repo.getExecutionSessionById(${JSON.stringify(created.id)});
    process.stdout.write(JSON.stringify(session));
  `;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    env: { ...process.env, DEVFLOW_DB_PATH: process.env.DEVFLOW_DB_PATH! },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const reloaded = JSON.parse(child.stdout);
  assert.equal(reloaded.id, created.id);
  assert.equal(reloaded.workspaceId, 'ws_restart');
  assert.equal(reloaded.contextHandle, 'ctx-restart');
  assert.equal(reloaded.lifecycle.stage, 'created');
  assert.deepEqual(reloaded.changedFiles, ['src/B.ts']);
  assert.equal(JSON.stringify(reloaded).includes(repoRoot), false);
});

test('rejects raw filesystem paths as workspace identity', () => {
  assert.throws(() => sessions.createExecutionSession({
    projectId: 'project-session',
    workspaceId: 'C:\\Users\\someone\\repo',
    repoRoot,
  }), /workspace identity/i);
});

test('resume selectively invalidates changed file evidence while reusing unchanged evidence', () => {
  const created = sessions.createExecutionSession({
    projectId: 'project-session',
    taskId: 'task-evidence',
    workspaceId: 'ws_evidence',
    branch: 'feature/evidence',
    repoRoot,
  });
  sessions.recordExecutionSessionEvidence(created.id, [
    { kind: 'file', path: 'src/A.ts' },
    { kind: 'file', path: 'src/B.ts' },
  ], { repoRoot });

  const before = repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'file');
  assert.equal(before.length, 2);
  assert.ok(before.every((entry) => entry.stale === false));
  const beforeB = before.find((entry) => entry.path === 'src/B.ts');

  fs.writeFileSync(path.join(repoRoot, 'src', 'A.ts'), 'export const A = 2;\n', 'utf8');
  const resumed = sessions.resumeExecutionSession(created.id, { repoRoot, workspaceId: 'ws_evidence' });

  assert.equal(resumed.resumable, true);
  assert.equal(resumed.staleEvidence.length, 1);
  assert.equal(resumed.staleEvidence[0].path, 'src/A.ts');
  const reusableFiles = resumed.reusableEvidence.filter((entry) => entry.kind === 'file');
  assert.equal(reusableFiles.length, 1);
  assert.equal(reusableFiles[0].path, 'src/B.ts');
  assert.equal(reusableFiles[0].revisionIdentity, beforeB?.revisionIdentity);

  const after = repository.listExecutionSessionEvidence(created.id);
  assert.equal(after.find((entry) => entry.path === 'src/A.ts')?.stale, true);
  assert.equal(after.find((entry) => entry.path === 'src/B.ts')?.stale, false);
});

test('records changed files, verification state, and context handle for active sessions', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_progress', repoRoot });
  const updated = sessions.updateExecutionSessionProgress(created.id, {
    contextHandle: 'ctx-123',
    changedFiles: ['src/A.ts'],
    verification: [{ name: 'focused', status: 'passed' }],
  });

  assert.equal(updated.contextHandle, 'ctx-123');
  assert.deepEqual(updated.changedFiles, ['src/A.ts']);
  assert.deepEqual(updated.verification, [{ name: 'focused', status: 'passed' }]);
});

test('tracks observable lifecycle stages independently from terminal session status', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle', repoRoot });
  assert.equal(created.status, 'active');
  assert.equal(created.lifecycle.stage, 'created');
  assert.equal(created.lifecycle.legacyCompatibility, false);

  const advance = (toStage: any, id: string, kind: string, reasonCode: string) => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage,
    reasonCode,
    evidence: { id, kind, status: 'completed', operationId: `op-${id}` },
  });
  advance('context-ready', 'context-1', 'context-bundle', 'context-ready');
  advance('plan-recorded', 'plan-1', 'plan-evidence', 'plan-recorded');
  advance('implementing', 'mutation-1', 'owned-change', 'mutation-applied');
  advance('verifying', 'verify-1', 'verification-candidate', 'verification-started');
  advance('repairing', 'repair-1', 'verification-result', 'verification-failed');
  advance('verifying', 'verify-2', 'verification-candidate', 'verification-retry');
  advance('committed', 'commit-1', 'git-commit', 'commit-created');
  advance('finalized', 'finalize-1', 'workspace-finalization', 'workspace-finalized');

  const active = repository.getExecutionSessionById(created.id)!;
  assert.equal(active.status, 'active');
  assert.equal(active.lifecycle.stage, 'finalized');
  assert.equal(active.lifecycle.lastTransition?.reasonCode, 'workspace-finalized');
  assert.equal(active.lifecycle.lastTransition?.sequence, 9);
  sessions.completeExecutionSession(created.id);
  assert.equal(repository.getExecutionSessionById(created.id)?.status, 'completed');
  assert.equal(repository.getExecutionSessionById(created.id)?.lifecycle.stage, 'finalized');
});

test('lifecycle retries are idempotent and invalid or in-flight transitions fail closed', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle_guard', repoRoot });
  const transition = {
    toStage: 'context-ready' as const,
    reasonCode: 'context-ready',
    evidence: { id: 'context-guard-1', kind: 'context-bundle', status: 'completed' as const, operationId: 'op-context-guard-1' },
  };
  const first = sessions.recordExecutionLifecycleTransition(created.id, transition);
  const retry = sessions.recordExecutionLifecycleTransition(created.id, transition);
  assert.equal(first.changed, true);
  assert.equal(retry.changed, false);
  assert.equal(retry.idempotent, true);
  assert.equal(repository.listExecutionSessionEvidence(created.id).filter((entry) => entry.kind === 'lifecycle-transition').length, 2);

  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'implementing', reasonCode: 'different-reconciliation', evidence: { ...transition.evidence, status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_IDEMPOTENCY_CONFLICT');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'verifying', reasonCode: 'skip-implementation', evidence: { id: 'verify-skip-1', kind: 'verification-candidate', status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_TRANSITION_BLOCKED');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'implementing', reasonCode: 'mutation-accepted', evidence: { id: 'mutation-accepted-1', kind: 'async-mutation', status: 'accepted' },
  }), (error: any) => error?.code === 'EXECUTION_LIFECYCLE_EVIDENCE_NOT_TERMINAL');
  assert.equal(repository.getExecutionSessionById(created.id)?.lifecycle.stage, 'context-ready');
});

test('resume preserves lifecycle state and legacy sessions remain conservative until explicit initialization', () => {
  const created = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_lifecycle_resume', repoRoot });
  sessions.recordExecutionLifecycleTransition(created.id, {
    toStage: 'context-ready', reasonCode: 'context-ready', evidence: { id: 'context-resume-1', kind: 'context-bundle', status: 'completed' },
  });
  const resumed = sessions.resumeExecutionSession(created.id, { repoRoot, workspaceId: 'ws_lifecycle_resume' });
  assert.equal(resumed.resumable, true);
  assert.equal(resumed.session.lifecycle.stage, 'context-ready');

  const legacyId = `exec-legacy-${Date.now()}`;
  const now = new Date().toISOString();
  repository.createExecutionSessionRecord({
    id: legacyId, projectId: 'project-session', taskId: null, workspaceId: 'ws_legacy_lifecycle', branch: 'legacy',
    baseRevision: null, repoRevision: null, status: 'active', contextHandle: null, changedFiles: [], verification: [],
    createdAt: now, updatedAt: now, expiresAt: new Date(Date.now() + 60_000).toISOString(), endedAt: null,
  });
  const legacy = repository.getExecutionSessionById(legacyId)!;
  assert.equal(legacy.lifecycle.stage, 'compatibility');
  assert.equal(legacy.lifecycle.legacyCompatibility, true);
  const legacyResumed = sessions.resumeExecutionSession(legacyId, { workspaceId: 'ws_legacy_lifecycle' });
  assert.equal(legacyResumed.session.lifecycle.stage, 'compatibility');
  sessions.recordExecutionLifecycleTransition(legacyId, {
    toStage: 'created', reasonCode: 'legacy-explicit-initialization', evidence: { id: 'legacy-init-1', kind: 'compatibility-initialization', status: 'completed' },
  });
  assert.equal(repository.getExecutionSessionById(legacyId)?.lifecycle.stage, 'created');
});

test('completed, cancelled, and expired sessions cannot mutate as active sessions', () => {
  const completed = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_completed', repoRoot });
  sessions.completeExecutionSession(completed.id, { changedFiles: ['src/A.ts'] });
  assert.equal(repository.getExecutionSessionById(completed.id)?.status, 'completed');
  assert.equal(repository.getExecutionSessionById(completed.id)?.lifecycle.stage, 'created');
  assert.throws(() => sessions.recordExecutionLifecycleTransition(completed.id, {
    toStage: 'context-ready', reasonCode: 'late-context', evidence: { id: 'late-context-completed', kind: 'context-bundle', status: 'completed' },
  }), (error: any) => error?.code === 'EXECUTION_SESSION_TERMINAL');
  assert.throws(() => sessions.updateExecutionSessionProgress(completed.id, { contextHandle: 'ctx-nope' }), /terminal/i);
  assert.throws(() => sessions.recordExecutionSessionEvidence(completed.id, [{ kind: 'file', path: 'src/A.ts' }], { repoRoot }), /terminal/i);
  assert.equal(sessions.resumeExecutionSession(completed.id, { repoRoot }).resumable, false);

  const cancelled = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_cancelled', repoRoot });
  sessions.cancelExecutionSession(cancelled.id);
  assert.equal(repository.getExecutionSessionById(cancelled.id)?.status, 'cancelled');
  assert.equal(repository.getExecutionSessionById(cancelled.id)?.lifecycle.stage, 'created');

  const expired = sessions.createExecutionSession({ projectId: 'project-session', workspaceId: 'ws_expired', repoRoot, ttlMs: 1 });
  const resumedExpired = sessions.resumeExecutionSession(expired.id, { repoRoot, now: new Date(Date.now() + 10_000) });
  assert.equal(resumedExpired.resumable, false);
  assert.equal(repository.getExecutionSessionById(expired.id)?.status, 'expired');
  assert.equal(repository.getExecutionSessionById(expired.id)?.lifecycle.stage, 'created');
});

test.after(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
});
