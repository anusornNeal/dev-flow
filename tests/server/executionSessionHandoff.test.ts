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
  assert.equal(snapshot.evidence.length, 2);
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
});

test.after(() => {
  try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch {}
});
