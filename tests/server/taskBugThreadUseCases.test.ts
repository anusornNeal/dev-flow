import test from 'node:test';
import assert from 'node:assert/strict';
import {
  appendBugVersion,
  createBugThread,
  getBugSummary,
  updateBugStatus,
} from '../../src/server/useCases/taskUseCases';

function makeTask() {
  return {
    id: 'task-bugs-api-1',
    displayId: 'DVF-BUGS',
    title: 'Bug thread fixture',
    status: 'todo',
    bugs: [],
    updatedAt: '2026-07-02T00:00:00.000Z',
  };
}

test('bug thread lifecycle creates embedded bugs, appends versions, updates status, and summarizes unresolved work', () => {
  const task = makeTask();

  const withBug = createBugThread(task, {
    title: 'Done warning missing',
    source: 'review',
    severity: 'high',
    actual: 'Task closes with unfinished checklist.',
    expected: 'Task shows unresolved bug warning.',
    evidence: 'Reviewer feedback',
    relatedAreas: ['src/server/routes/tasks.ts'],
    prompt: 'Fix the missing warning.',
    createdBy: 'Codex',
  });

  assert.equal(withBug.bugs.length, 1);
  assert.equal(withBug.bugs[0].taskId, task.id);
  assert.equal(withBug.bugs[0].versions[0].version, 1);
  assert.equal(withBug.bugs[0].versions[0].prompt, 'Fix the missing warning.');
  assert.notEqual(withBug.updatedAt, task.updatedAt);

  const withVersion = appendBugVersion(withBug, withBug.bugs[0].id, {
    prompt: 'Second attempt for the same behavior.',
    summary: 'First fix failed review.',
    changedFiles: ['src/server/routes/tasks.ts'],
    createdBy: 'Codex',
  });

  assert.equal(withVersion.bugs[0].versions.length, 2);
  assert.equal(withVersion.bugs[0].versions[1].version, 2);
  assert.equal(withVersion.bugs[0].versions[1].status, 'open');

  const fixed = updateBugStatus(withVersion, withVersion.bugs[0].id, 'fixed');
  assert.equal(fixed.bugs[0].status, 'fixed');

  const summary = getBugSummary(withVersion);
  assert.equal(summary.unresolvedBugCount, 1);
  assert.equal(summary.latestUnresolvedBug?.id, withVersion.bugs[0].id);
  assert.equal(summary.orderedBugs[0].id, withVersion.bugs[0].id);
});

test('bug lifecycle helpers never create top-level task records for bugs', () => {
  const task = makeTask();
  const result = createBugThread(task, {
    title: 'Embedded only',
    source: 'manual',
    severity: 'medium',
    prompt: 'Keep bug inside task.',
  });

  assert.equal(result.id, task.id);
  assert.equal(result.bugs[0].taskId, task.id);
  assert.equal((result.bugs[0] as any).parentId, undefined);
});
