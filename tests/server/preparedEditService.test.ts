import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-prepared-edit-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { applyPreparedEditPlan, clearPreparedEditPlans, prepareEditPlan } = await import('../../src/server/services/preparedEditService.js');

const state: any = {
  projectsCache: [
    { id: 'project-prepared-edit', name: 'Prepared Edit Fixture', repoUrl: 'https://example.com/prepared-edit', localPath: tempDir },
  ],
};

function write(name: string, content: string) {
  fs.writeFileSync(path.join(tempDir, name), content, 'utf8');
}

function read(name: string) {
  return fs.readFileSync(path.join(tempDir, name), 'utf8');
}

test.beforeEach(() => {
  clearPreparedEditPlans();
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

test.after(() => {
  clearPreparedEditPlans();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
