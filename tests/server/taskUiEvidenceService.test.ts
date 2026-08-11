import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-task-ui-evidence-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createTaskUiEvidenceRepository } = await import('../../src/server/repositories/taskUiEvidenceRepository.js');
const { createUiPreviewService } = await import('../../src/server/services/uiPreviewService.js');
const { createTaskUiEvidenceService } = await import('../../src/server/services/taskUiEvidenceService.js');

const previewRepository = createUiPreviewRepository(db as any);
const evidenceRepository = createTaskUiEvidenceRepository(db as any);
const spec = { schemaVersion: 1, summary: { screen: 'Evidence' } };
let previewCounter = 0;
let evidenceCounter = 0;
let artifactCounter = 0;
let captureCount = 0;

function png() {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
}

function artifactId() {
  artifactCounter += 1;
  return `uisa_${artifactCounter.toString(16).padStart(32, '0')}`;
}

function seedTask(id = 'task-a') {
  db.prepare('INSERT OR IGNORE INTO tasks (id, title, status) VALUES (?, ?, ?)').run(id, id, 'todo');
}

function reset() {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_idempotency; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews; DELETE FROM tasks;');
  previewCounter = 0;
  evidenceCounter = 0;
  artifactCounter = 0;
  captureCount = 0;
}

test.beforeEach(reset);

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

function createPreviewService() {
  return createUiPreviewService({
    repository: previewRepository,
    runtimePort: () => 43210,
    createId: () => `uip_test_${++previewCounter}`,
  });
}

function createEvidenceService(capture?: (input: any) => Promise<any>) {
  return createTaskUiEvidenceService({
    database: db as any,
    previewRepository,
    evidenceRepository,
    screenshotService: {
      capture: capture || (async (input: any) => {
        captureCount += 1;
        return { artifactId: artifactId(), absolutePath: path.join(tempRoot, 'ignored.png'), png: png(), viewport: input.viewport };
      }),
    } as any,
    runtimePort: () => 43210,
    createEvidenceId: () => `uie_${++evidenceCounter}`,
  });
}

test('attach freezes one revision, replays persisted idempotency without recapture, and keeps latest live', async () => {
  seedTask();
  const previews = createPreviewService();
  const evidence = createEvidenceService();
  const created = previews.create({ html: '<main>rev1</main>', spec, idempotencyKey: 'create-1' });

  const first = await evidence.attach({ taskId: 'task-a', previewId: created.previewId, idempotencyKey: 'attach-latest' });
  assert.equal(first.frozenRevision, 1);
  assert.equal(first.latestRevision, 1);
  assert.equal(first.current, true);
  assert.match(first.frozenPreviewUrl, /revision=1/);
  assert.match(first.screenshotUrl, /^http:\/\/127\.0\.0\.1:43210\/api\/ui-preview-artifacts\/uisa_/);
  assert.equal(captureCount, 1);

  previews.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>rev2</main>' });
  const replay = await evidence.attach({ taskId: 'task-a', previewId: created.previewId, idempotencyKey: 'attach-latest' });
  assert.equal(replay.evidenceId, first.evidenceId);
  assert.equal(replay.frozenRevision, 1);
  assert.equal(replay.latestRevision, 2);
  assert.equal(replay.replayed, true);
  assert.equal(captureCount, 1, 'a delayed idempotent retry must not recapture');

  await assert.rejects(
    evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 2, idempotencyKey: 'attach-latest' }),
    (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT',
  );
});

test('same revision collapses and a late lower revision can never supersede a higher current revision', async () => {
  seedTask();
  const previews = createPreviewService();
  const created = previews.create({ html: '<main>rev1</main>', spec });
  previews.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>rev2</main>' });
  previews.update({ previewId: created.previewId, expectedRevision: 2, html: '<main>rev3</main>' });

  let resolveTwo!: (value: any) => void;
  let resolveThree!: (value: any) => void;
  const two = new Promise<any>((resolve) => { resolveTwo = resolve; });
  const three = new Promise<any>((resolve) => { resolveThree = resolve; });
  const evidence = createEvidenceService(async (input: any) => {
    captureCount += 1;
    if (String(input.html).includes('rev2')) return two;
    if (String(input.html).includes('rev3')) return three;
    return { artifactId: artifactId(), absolutePath: '', png: png(), viewport: input.viewport };
  });

  const lateTwo = evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 2 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const fastThree = evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 3 });
  resolveThree({ artifactId: artifactId(), absolutePath: '', png: png(), viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
  const current = await fastThree;
  assert.equal(current.frozenRevision, 3);

  resolveTwo({ artifactId: artifactId(), absolutePath: '', png: png(), viewport: { width: 1440, height: 900, deviceScaleFactor: 1 } });
  await assert.rejects(lateTwo, (error: any) => error?.code === 'UI_PREVIEW_EVIDENCE_REVISION_STALE');
  assert.equal(evidenceRepository.getCurrentEvidence('task-a', created.previewId)?.frozenRevision, 3);

  const duplicate = await evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 3 });
  assert.equal(duplicate.evidenceId, current.evidenceId);
  assert.equal(captureCount, 2, 'already-current same revision must not recapture');
});

test('evidence history is cursor-paged, newest-first, hard-capped, and never returns raw preview source or screenshot bytes', async () => {
  seedTask();
  const previews = createPreviewService();
  const evidence = createEvidenceService();
  const created = previews.create({ title: 'Frozen title', html: '<main>rev1 secret-source</main>', css: 'secret-css', js: 'secret-js', spec });
  await evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 1 });
  previews.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>rev2 secret-source</main>' });
  await evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 2 });
  previews.update({ previewId: created.previewId, expectedRevision: 2, html: '<main>rev3 secret-source</main>' });
  await evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 3 });

  const first = evidence.list({ taskId: 'task-a', limit: 2 });
  assert.equal(first.limit, 2);
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.deepEqual(first.items.map((item: any) => item.frozenRevision), [3, 2]);
  const second = evidence.list({ taskId: 'task-a', limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.items.map((item: any) => item.frozenRevision), [1]);
  assert.equal(second.nextCursor, null);

  const capped = evidence.list({ taskId: 'task-a', limit: 999 });
  assert.equal(capped.limit, 50);
  const serialized = JSON.stringify(capped);
  assert.doesNotMatch(serialized, /secret-source|secret-css|secret-js/);
  assert.equal('png' in capped.items[0], false);
  assert.equal('absolutePath' in capped.items[0], false);
  assert.deepEqual(capped.items[0].spec, spec);
});

test('failed capture leaves a standalone preview unbound and retryable', async () => {
  seedTask('task-a');
  const previews = createPreviewService();
  const created = previews.create({ html: '<main>standalone</main>', spec });
  const failing = createEvidenceService(async () => {
    throw Object.assign(new Error('renderer unavailable'), { code: 'UI_PREVIEW_RENDERER_UNAVAILABLE' });
  });

  await assert.rejects(failing.attach({ taskId: 'task-a', previewId: created.previewId, idempotencyKey: 'failed-capture' }));
  assert.equal(previewRepository.getPreview(created.previewId)?.taskId, null);
  assert.equal(evidenceRepository.getCurrentEvidence('task-a', created.previewId), null);

  const retry = await createEvidenceService().attach({ taskId: 'task-a', previewId: created.previewId, idempotencyKey: 'retry-after-failure' });
  assert.equal(retry.taskId, 'task-a');
  assert.equal(previewRepository.getPreview(created.previewId)?.taskId, 'task-a');
});

test('evidence-record failure rolls back task binding', async () => {
  seedTask('task-a');
  const previews = createPreviewService();
  const created = previews.create({ html: '<main>record failure</main>', spec });
  const failingRepository = {
    ...evidenceRepository,
    recordEvidence: () => { throw new Error('record failed'); },
  };
  const service = createTaskUiEvidenceService({
    database: db as any,
    previewRepository,
    evidenceRepository: failingRepository as any,
    screenshotService: { capture: async (input: any) => ({ artifactId: artifactId(), absolutePath: '', png: png(), viewport: input.viewport }) } as any,
    runtimePort: () => 43210,
  });

  await assert.rejects(service.attach({ taskId: 'task-a', previewId: created.previewId }));
  assert.equal(previewRepository.getPreview(created.previewId)?.taskId, null);
});

test('concurrent different-task attach cannot leave evidence for the losing task', async () => {
  seedTask('task-a'); seedTask('task-b');
  const previews = createPreviewService();
  const created = previews.create({ html: '<main>race</main>', spec });
  const captures: Array<(value: any) => void> = [];
  const service = createEvidenceService((input: any) => new Promise((resolve) => captures.push(() => resolve({ artifactId: artifactId(), absolutePath: '', png: png(), viewport: input.viewport }))));

  const first = service.attach({ taskId: 'task-a', previewId: created.previewId });
  const second = service.attach({ taskId: 'task-b', previewId: created.previewId });
  await new Promise((resolve) => setTimeout(resolve, 0));
  captures[0]!(true);
  await first;
  captures[1]!(true);
  await assert.rejects(second, (error: any) => error?.code === 'UI_PREVIEW_TASK_CONFLICT');
  assert.equal(previewRepository.getPreview(created.previewId)?.taskId, 'task-a');
  assert.equal(evidenceRepository.getCurrentEvidence('task-b', created.previewId), null);
});

test('fresh evidence reads regenerate frozen/latest/screenshot URLs from the current runtime port', async () => {
  seedTask();
  let runtimePort = 43210;
  const previews = createUiPreviewService({
    repository: previewRepository,
    runtimePort: () => runtimePort,
    createId: () => `uip_test_${++previewCounter}`,
  });
  const evidence = createTaskUiEvidenceService({
    database: db as any,
    previewRepository,
    evidenceRepository,
    screenshotService: {
      capture: async (input: any) => ({ artifactId: artifactId(), absolutePath: path.join(tempRoot, 'ignored.png'), png: png(), viewport: input.viewport }),
    } as any,
    runtimePort: () => runtimePort,
    createEvidenceId: () => `uie_${++evidenceCounter}`,
  });
  const created = previews.create({ html: '<main>runtime-port</main>', spec });
  const attached = await evidence.attach({ taskId: 'task-a', previewId: created.previewId, revision: 1 });
  assert.match(attached.frozenPreviewUrl, /127\.0\.0\.1:43210/);
  assert.match(attached.screenshotUrl, /127\.0\.0\.1:43210/);

  runtimePort = 45678;
  const refreshed = evidence.list({ taskId: 'task-a', limit: 20 }).items[0];
  assert.match(refreshed.frozenPreviewUrl, /127\.0\.0\.1:45678/);
  assert.match(refreshed.latestPreviewUrl, /127\.0\.0\.1:45678/);
  assert.match(refreshed.screenshotUrl, /127\.0\.0\.1:45678/);
  assert.doesNotMatch(JSON.stringify(refreshed), /43210/);
});
