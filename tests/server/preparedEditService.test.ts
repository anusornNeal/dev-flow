import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-prepared-edit-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

const { applyPreparedEditPlan, clearPreparedEditPlans, prepareEditPlan, __setPreparedEditTestHooks } = await import('../../src/server/services/preparedEditService.js');
const { clearRepoChangeJournal, getRepoChangesSince } = await import('../../src/server/services/repoChangeJournalService.js');

const state: any = {
  projectsCache: [
    { id: 'project-prepared-edit', name: 'Prepared Edit Fixture', repoUrl: 'https://example.com/prepared-edit', localPath: tempDir },
  ],
};
createProject(state.projectsCache[0]);

function write(name: string, content: string) {
  fs.writeFileSync(path.join(tempDir, name), content, 'utf8');
}

function read(name: string) {
  return fs.readFileSync(path.join(tempDir, name), 'utf8');
}

test.beforeEach(() => {
  clearPreparedEditPlans();
  clearRepoChangeJournal(tempDir);
  __setPreparedEditTestHooks(null);
});

test('prepareEditPlan validates once and applyPreparedEditPlan applies by id', () => {
  write('a.txt', 'alpha one');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'a.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
    ],
  });

  assert.equal(prepared.ok, true);
  assert.ok(prepared.editPlanId);
  assert.equal(read('a.txt'), 'alpha one');

  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  assert.equal(applied.ok, true);
  assert.equal(applied.changed, true);
  assert.equal(read('a.txt'), 'alpha uno');
});

test('applyPreparedEditPlan rejects stale files before any write', () => {
  write('first.txt', 'first one');
  write('second.txt', 'second two');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'first.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'second.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });
  assert.equal(prepared.ok, true);

  write('second.txt', 'newer content');
  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });

  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'EDIT_PLAN_STALE');
  assert.equal(read('first.txt'), 'first one');
  assert.equal(read('second.txt'), 'newer content');
});

test('prepared edit plans are single-use', () => {
  write('single.txt', 'single one');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'single.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
    ],
  });
  assert.equal(prepared.ok, true);

  const first = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  const second = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });

  assert.equal(first.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.code, 'EDIT_PLAN_CONSUMED');
});

test('prepareEditPlan preserves the underlying safe-edit error code', () => {
  write('missing-anchor.txt', 'alpha one');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'missing-anchor.txt', edits: [{ type: 'replace', find: 'missing', replaceWith: 'value' }] },
    ],
  });

  assert.equal(prepared.ok, false);
  assert.equal(prepared.code, 'NO_MATCH');
  assert.match(String(prepared.message), /No match/i);
});

test('prepared plan default TTL is agent-friendly and bounded', () => {
  write('ttl.txt', 'alpha one');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [{ filePath: 'ttl.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] }],
  });
  assert.equal(prepared.ok, true);
  const lifetimeMs = Date.parse(prepared.expiresAt!) - Date.parse(prepared.createdAt!);
  assert.equal(lifetimeMs >= 120_000, true);
  assert.equal(lifetimeMs <= 300_000, true);
});

test('failed stale apply consumes the plan instead of silently allowing replay', () => {
  write('stale-consumed.txt', 'alpha one');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [{ filePath: 'stale-consumed.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] }],
  });
  write('stale-consumed.txt', 'external');

  const first = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  const second = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  assert.equal(first.code, 'EDIT_PLAN_STALE');
  assert.equal(second.code, 'EDIT_PLAN_CONSUMED');
});

test('later per-file stale failure rolls back earlier writes and invalidates caches', () => {
  write('rollback-first.txt', 'first one');
  write('rollback-second.txt', 'second two');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'rollback-first.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'rollback-second.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });
  __setPreparedEditTestHooks({
    beforeApplyFile: ({ index }: any) => {
      if (index === 1) write('rollback-second.txt', 'changed after global precheck');
    },
  });

  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'EDIT_PLAN_APPLY_FAILED');
  assert.equal(read('rollback-first.txt'), 'first one');
  assert.equal(read('rollback-second.txt'), 'changed after global precheck');
  assert.deepEqual(applied.rollback?.restored, ['rollback-first.txt']);
  assert.equal(getRepoChangesSince(tempDir, 0).events.some((event: any) => event.reason === 'preparedEditRollback'), true);
});

test('rollback compare-before-restore preserves third-party post-write changes', () => {
  write('conflict-first.txt', 'first one');
  write('conflict-second.txt', 'second two');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'conflict-first.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'conflict-second.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });
  __setPreparedEditTestHooks({
    beforeApplyFile: ({ index }: any) => {
      if (index === 1) {
        write('conflict-first.txt', 'third-party change');
        write('conflict-second.txt', 'later stale');
      }
    },
  });

  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  assert.equal(applied.code, 'EDIT_PLAN_APPLY_FAILED');
  assert.equal(read('conflict-first.txt'), 'third-party change');
  assert.deepEqual(applied.rollback?.conflicts, ['conflict-first.txt']);
});

test('rollback write errors are reported structurally and never escape', () => {
  write('rollback-error-first.txt', 'first one');
  write('rollback-error-second.txt', 'second two');
  const prepared = prepareEditPlan(state, {
    projectId: 'project-prepared-edit',
    files: [
      { filePath: 'rollback-error-first.txt', edits: [{ type: 'replace', find: 'one', replaceWith: 'uno' }] },
      { filePath: 'rollback-error-second.txt', edits: [{ type: 'replace', find: 'two', replaceWith: 'dos' }] },
    ],
  });
  __setPreparedEditTestHooks({
    beforeApplyFile: ({ index }: any) => {
      if (index === 1) write('rollback-error-second.txt', 'later stale');
    },
    rollbackWrite: () => {
      throw new Error('synthetic rollback write failure');
    },
  });

  const applied = applyPreparedEditPlan({ editPlanId: prepared.editPlanId! });
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'EDIT_PLAN_APPLY_FAILED');
  assert.equal(applied.rollback?.failures.length, 1);
  assert.match(applied.rollback?.failures[0].message || '', /synthetic rollback/i);
});

test.after(() => {
  clearPreparedEditPlans();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
