import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-service-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
const { createUiPreviewService } = await import('../../src/server/services/uiPreviewService.js');

const repository = createUiPreviewRepository(db as any);
const service = createUiPreviewService({ repository, runtimePort: () => 43123 });
const spec = { schemaVersion: 1, summary: { screen: 'Service' }, sections: [{ id: 'main' }] };

function createWorkspaceService(serviceDeps: Record<string, any> = {}) {
  const previews = new Map<string, { record: any; revisions: any[] }>();
  const idempotency = new Map<string, { fingerprint: string; result: any }>();
  let previewId = 0;
  const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
  const repository = {
    runIdempotent(operation: string, key: string | undefined, fingerprint: string, work: () => any) {
      if (!key) return { replayed: false, result: work() };
      const storageKey = `${operation}:${key}`;
      const existing = idempotency.get(storageKey);
      if (existing) {
        if (existing.fingerprint !== fingerprint) {
          const error: any = new Error('idempotency conflict');
          error.code = 'UI_PREVIEW_IDEMPOTENCY_CONFLICT';
          throw error;
        }
        return { replayed: true, result: clone(existing.result) };
      }
      const result = work();
      idempotency.set(storageKey, { fingerprint, result: clone(result) });
      return { replayed: false, result };
    },
    createPreview(input: any) {
      const createdAt = '2026-08-17T00:00:00.000Z';
      const record = { id: input.id, taskId: input.taskId ?? null, latestRevision: 1, createdAt, updatedAt: createdAt };
      const revision = { ...clone(input), previewId: input.id, revision: 1, createdAt };
      previews.set(input.id, { record, revisions: [revision] });
      return record;
    },
    getPreview(id: string) {
      return previews.get(id)?.record ?? null;
    },
    getRevision(id: string, revision?: number) {
      const stored = previews.get(id);
      if (!stored) return null;
      const selected = revision ?? stored.record.latestRevision;
      return stored.revisions.find((item) => item.revision === selected) ?? null;
    },
    appendRevision(input: any) {
      const stored = previews.get(input.previewId);
      if (!stored) throw new Error('missing preview');
      if (input.expectedRevision !== undefined && input.expectedRevision !== stored.record.latestRevision) {
        const error: any = new Error('revision conflict');
        error.code = 'UI_PREVIEW_REVISION_CONFLICT';
        throw error;
      }
      const current = stored.revisions[stored.revisions.length - 1];
      const comparable = (value: any) => value.contentHash;
      if (comparable(current) === comparable(input)) return { changed: false, preview: stored.record, revision: current };
      const nextRevision = stored.record.latestRevision + 1;
      const createdAt = `2026-08-17T00:00:0${nextRevision}.000Z`;
      const revision = { ...clone(input), previewId: input.previewId, revision: nextRevision, createdAt };
      stored.revisions.push(revision);
      stored.record.latestRevision = nextRevision;
      stored.record.updatedAt = createdAt;
      return { changed: true, preview: stored.record, revision };
    },
    listPreviews(input: any = {}) {
      const items = [...previews.values()].map(({ record, revisions }) => {
        const revision = revisions[revisions.length - 1];
        return {
          previewId: record.id,
          taskId: record.taskId,
          title: revision.title,
          specSummary: revision.spec?.summary ?? {},
          latestRevision: record.latestRevision,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          linkedTask: null,
        };
      });
      return { items, nextCursor: null, limit: input.limit ?? 20, filter: input.filter ?? 'all' };
    },
  } as any;
  return {
    service: createUiPreviewService({ repository, runtimePort: () => 43123, createId: () => `uip_workspace_${++previewId}`, ...serviceDeps }),
    repository,
  };
}

function designContext(overrides: Record<string, any> = {}) {
  return {
    taskId: null,
    projectId: 'project-a',
    repositoryRevision: 'repo-a',
    contextSchemaVersion: 1,
    gatePolicyVersion: 'ui-preview-design-gate.v1',
    contextHash: 'a'.repeat(64),
    sufficiency: 'sufficient',
    reasonCodes: ['VISUAL_BASIS_FOUND', 'CONTEXT_COMPLETE'],
    visual: {
      colors: ['#2457d6'], semanticColors: ['primary'], fontFamilies: ['Inter'], fontWeights: ['400'],
      spacing: ['8px'], radii: ['8px'], dimensions: ['40px'], iconConventions: [], sharedComponents: [], referenceScreens: [],
    },
    ux: { ruleIds: [] },
    unknowns: [],
    sources: [{ path: 'src/styles/theme.css', startLine: 1, endLine: 20, trustClass: 'repo-evidence-untrusted', evidenceRole: 'project-foundation' }],
    renderAssets: [],
    ...overrides,
  };
}

function createScopedWorkspaceService() {
  let currentContext = designContext();
  let contextCalls = 0;
  const designContextService = {
    get(input: any) {
      contextCalls += 1;
      if (input.taskId && input.projectId && input.projectId !== currentContext.projectId) {
        const error: any = new Error('scope mismatch');
        error.code = 'UI_PREVIEW_DESIGN_CONTEXT_PROJECT_MISMATCH';
        throw error;
      }
      return JSON.parse(JSON.stringify({
        ...currentContext,
        taskId: input.taskId ? 'task-scoped' : null,
      }));
    },
  };
  const created = createWorkspaceService({ designContextService });
  return {
    ...created,
    setContext(next: Record<string, any>) { currentContext = designContext(next); },
    getContextCalls() { return contextCalls; },
  };
}

function reset() {
  db.exec('DELETE FROM task_ui_evidence; DELETE FROM ui_preview_idempotency; DELETE FROM ui_preview_revisions; DELETE FROM ui_previews; DELETE FROM tasks;');
}

function seedTask(id: string) {
  db.prepare('INSERT INTO tasks (id, title, status) VALUES (?, ?, ?)').run(id, id, 'todo');
}

test.beforeEach(reset);

test('create returns bounded metadata and source is opt-in', () => {
  const created = service.create({ title: 'Demo', html: '<main>hello</main>', css: 'main{}', js: 'window.x=1', spec });
  assert.match(created.previewId, /^uip_/);
  assert.equal(created.revision, 1);
  assert.equal(created.latestRevision, 1);
  assert.equal(created.changed, true);
  assert.equal('html' in created, false);
  assert.equal('css' in created, false);
  assert.match(created.previewUrl, /^http:\/\/127\.0\.0\.1:43123\//);

  const summary = service.get({ previewId: created.previewId });
  assert.equal('html' in summary, false);
  assert.equal('spec' in summary, false);
  assert.equal(summary.specSummary.screen, 'Service');

  const source = service.get({ previewId: created.previewId, mode: 'source' });
  assert.equal(source.html, '<main>hello</main>');
  assert.equal(source.css, 'main{}');
  assert.equal(source.js, 'window.x=1');
  assert.deepEqual(source.spec, spec);
});

test('multi-screen service preserves canonical workspace metadata, full replacement, and idempotency identity', () => {
  const { service: workspaceService } = createWorkspaceService();
  const screens = [
    { screenId: 'overview', name: 'Overview', html: '<main>secret-overview</main>', css: 'o{}', js: 'o()', spec: { schemaVersion: 1, summary: { screen: 'Overview' } } },
    { screenId: 'details', name: 'Details', html: '<main>secret-details</main>', css: 'd{}', js: 'd()', spec: { schemaVersion: 1, summary: { screen: 'Details' } } },
  ];
  const created = workspaceService.create({ title: 'Workspace', screens, defaultScreenId: 'details', idempotencyKey: 'workspace-create' });
  assert.equal(created.screenCount, 2);
  assert.equal(created.defaultScreenId, 'details');
  assert.equal(created.defaultScreenSummary.name, 'Details');
  assert.equal(created.specSummary.screen, 'Details');

  const summary = workspaceService.get({ previewId: created.previewId });
  assert.equal(summary.screenCount, 2);
  assert.equal(summary.defaultScreenId, 'details');
  assert.equal('screens' in summary, false);
  assert.equal('html' in summary, false);

  const source = workspaceService.get({ previewId: created.previewId, mode: 'source' });
  assert.deepEqual(source.screens, screens);
  assert.equal(source.defaultScreenId, 'details');
  assert.equal(source.html, '<main>secret-details</main>', 'legacy source aliases follow the default screen');
  assert.equal(source.spec.summary.screen, 'Details');

  const page = workspaceService.list({ filter: 'all', limit: 20 });
  assert.equal(page.items[0].screenCount, 2);
  assert.equal(page.items[0].defaultScreenId, 'details');
  assert.equal(page.items[0].defaultScreenSummary.name, 'Details');
  assert.doesNotMatch(JSON.stringify(page), /secret-overview|secret-details|o\(\)|d\(\)/);

  const replacement = [
    { ...screens[0], html: '<main>overview-v2</main>' },
    { ...screens[1], html: '<main>details-v2</main>' },
  ];
  const updated = workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: replacement,
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.defaultScreenId, 'overview');
  assert.equal(updated.defaultScreenSummary.name, 'Overview');

  const replay = workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: replacement,
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  });
  assert.equal(replay.revision, 2);
  assert.equal(replay.replayed, true);
  assert.throws(() => workspaceService.update({
    previewId: created.previewId,
    expectedRevision: 1,
    screens: [{ ...replacement[0], html: '<main>different</main>' }, replacement[1]],
    defaultScreenId: 'overview',
    idempotencyKey: 'workspace-update',
  }), (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT');
  assert.throws(() => workspaceService.update({ previewId: created.previewId, html: '<main>legacy patch</main>' }), /replace the complete screens array/i);
});

test('new unscoped preview remains unscoped after later task attachment metadata appears', () => {
  const { service: workspaceService, repository } = createWorkspaceService();
  const created = workspaceService.create({ html: '<main>standalone</main>', spec });
  assert.deepEqual(created.scope, { kind: 'unscoped' });
  repository.getPreview(created.previewId).taskId = 'task-attached-later';

  const updated = workspaceService.update({ previewId: created.previewId, html: '<main>standalone v2</main>' });
  assert.equal(updated.changed, true);
  assert.deepEqual(updated.scope, { kind: 'unscoped' });
  assert.deepEqual((workspaceService.get({ previewId: created.previewId, mode: 'source' }) as any).scope, { kind: 'unscoped' });
});

test('scoped create requires a current design-context handshake and rejects mismatch or insufficient context before write', () => {
  const scoped = createScopedWorkspaceService();
  const source = { projectId: 'project-a', html: '<main>scoped</main>', spec: { schemaVersion: 1, summary: { screen: 'Scoped' } } };
  assert.throws(
    () => scoped.service.create(source as any),
    (error: any) => error?.code === 'UI_PREVIEW_DESIGN_CONTEXT_REQUIRED',
  );
  assert.equal(scoped.repository.getPreview('uip_workspace_1'), null);

  assert.throws(
    () => scoped.service.create({ ...source, expectedDesignContextHash: 'b'.repeat(64) } as any),
    (error: any) => error?.code === 'UI_PREVIEW_DESIGN_CONTEXT_STALE',
  );
  assert.equal(scoped.repository.getPreview('uip_workspace_1'), null);

  scoped.setContext({ sufficiency: 'insufficient', reasonCodes: ['NO_VISUAL_BASIS'], unknowns: ['palette'] });
  assert.throws(
    () => scoped.service.create({ ...source, expectedDesignContextHash: 'a'.repeat(64) } as any),
    (error: any) => error?.code === 'UI_PREVIEW_DESIGN_CONTEXT_INSUFFICIENT',
  );

  scoped.setContext({});
  assert.throws(
    () => scoped.service.create({ taskId: 'task-scoped', projectId: 'project-b', expectedDesignContextHash: 'a'.repeat(64), html: '<main>x</main>', spec } as any),
    (error: any) => error?.code === 'UI_PREVIEW_SCOPE_MISMATCH',
  );
});

test('accepted scoped revisions persist bounded provenance and meaningful context identity without repo-revision churn', () => {
  const scoped = createScopedWorkspaceService();
  const created = scoped.service.create({
    projectId: 'project-a',
    expectedDesignContextHash: 'a'.repeat(64),
    html: '<main>scoped</main>',
    spec: { schemaVersion: 1, summary: { screen: 'Scoped' } },
  } as any);
  assert.deepEqual(created.scope, { kind: 'project', projectId: 'project-a' });
  assert.equal(created.designProvenance.contextHash, 'a'.repeat(64));
  assert.equal(created.designProvenance.repositoryRevision, 'repo-a');
  assert.equal(created.designProvenance.sufficiency, 'sufficient');
  assert.equal('html' in created.designProvenance, false);
  assert.equal('css' in created.designProvenance, false);

  scoped.setContext({ repositoryRevision: 'repo-unrelated', contextHash: 'a'.repeat(64) });
  const noOp = scoped.service.update({
    previewId: created.previewId,
    expectedRevision: 1,
    projectId: 'project-a',
    expectedDesignContextHash: 'a'.repeat(64),
  } as any);
  assert.equal(noOp.changed, false);
  assert.equal(noOp.revision, 1);
  assert.equal(noOp.designProvenance.repositoryRevision, 'repo-a', 'no-op retains accepted historical provenance snapshot');

  scoped.setContext({ repositoryRevision: 'repo-meaningful', contextHash: 'c'.repeat(64) });
  const changed = scoped.service.update({
    previewId: created.previewId,
    expectedRevision: 1,
    projectId: 'project-a',
    expectedDesignContextHash: 'c'.repeat(64),
  } as any);
  assert.equal(changed.changed, true);
  assert.equal(changed.revision, 2);
  assert.equal(changed.designProvenance.contextHash, 'c'.repeat(64));
});

test('scoped idempotent replay returns the originally accepted context snapshot without recomputing current context', () => {
  const scoped = createScopedWorkspaceService();
  const request = {
    projectId: 'project-a',
    expectedDesignContextHash: 'a'.repeat(64),
    html: '<main>replay</main>',
    spec: { schemaVersion: 1, summary: { screen: 'Replay' } },
    idempotencyKey: 'scoped-create',
  };
  const first = scoped.service.create(request as any);
  const callsAfterFirst = scoped.getContextCalls();
  scoped.setContext({ repositoryRevision: 'repo-later', contextHash: 'f'.repeat(64) });
  const replay = scoped.service.create(request as any);
  assert.equal(replay.replayed, true);
  assert.equal(replay.previewId, first.previewId);
  assert.equal(replay.designProvenance.contextHash, 'a'.repeat(64));
  assert.equal(replay.designProvenance.repositoryRevision, 'repo-a');
  assert.equal(scoped.getContextCalls(), callsAfterFirst, 'accepted replay bypasses current context recomputation');
});

test('scoped update cannot retarget immutable preview scope', () => {
  const scoped = createScopedWorkspaceService();
  const created = scoped.service.create({
    projectId: 'project-a', expectedDesignContextHash: 'a'.repeat(64), html: '<main>x</main>', spec,
  } as any);
  assert.throws(() => scoped.service.update({
    previewId: created.previewId,
    projectId: 'project-b',
    expectedDesignContextHash: 'a'.repeat(64),
  } as any), (error: any) => error?.code === 'UI_PREVIEW_SCOPE_MISMATCH');
});

test('public source exposes bounded provenance but internal render read alone carries immutable font snapshot', () => {
  const fontSnapshot = {
    contextHash: 'a'.repeat(64),
    fontRenderability: 'available',
    fonts: [{ assetId: 'font_inter', contentIdentity: `sha256:${'b'.repeat(64)}`, family: 'Inter', weight: 400, style: 'normal', mimeType: 'font/woff2', format: 'woff2', dataUri: 'data:font/woff2;base64,d09GMg==' }],
    unavailable: [],
  } as any;
  const current = designContext({
    renderAssets: [{ assetId: 'font_inter', kind: 'font', contentIdentity: `sha256:${'b'.repeat(64)}`, font: { family: 'Inter', weight: 400, style: 'normal', mimeType: 'font/woff2', byteLength: 4 } }],
  });
  const scoped = createWorkspaceService({
    designContextService: { get: () => JSON.parse(JSON.stringify(current)) },
    materializeFonts: () => fontSnapshot,
  });
  const created = scoped.service.create({
    projectId: 'project-a', expectedDesignContextHash: 'a'.repeat(64), html: '<main>font</main>', spec,
  } as any);
  const publicSource = scoped.service.get({ previewId: created.previewId, mode: 'source' }) as any;
  assert.equal(publicSource.designProvenance.contextHash, 'a'.repeat(64));
  assert.equal('fontSnapshot' in publicSource, false);
  assert.doesNotMatch(JSON.stringify(publicSource), /data:font/);

  const renderSource = (scoped.service as any).getForRender({ previewId: created.previewId }) as any;
  assert.equal(renderSource.designProvenance.contextHash, 'a'.repeat(64));
  assert.equal(renderSource.fontSnapshot.fonts[0].dataUri, 'data:font/woff2;base64,d09GMg==');
});

test('canonical hash is stable across spec key insertion order and exact-source significant', () => {
  const a = service.create({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'A', b: 2, a: 1 }, z: { y: 2, x: 1 } } });
  const b = service.create({ html: '<main>x</main>', spec: { z: { x: 1, y: 2 }, summary: { a: 1, b: 2, screen: 'A' }, schemaVersion: 1 } });
  assert.equal(a.contentHash, b.contentHash);
  const golden = service.create({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'A' } } });
  assert.equal(golden.contentHash, '8e9874a27899efd70d0089a0ae570269e2a605e7be799e79914d1f647becae24');
  const c = service.create({ html: '<main>x</main>\n', spec: { schemaVersion: 1, summary: { screen: 'A', a: 1, b: 2 }, z: { x: 1, y: 2 } } });
  assert.notEqual(a.contentHash, c.contentHash);
});

test('update is patch-like, supports explicit clears, duplicate suppression, and intentional revert', () => {
  const created = service.create({ title: 'Title', html: '<main>a</main>', css: 'a{}', js: 'x()', spec });
  const rev2 = service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>b</main>' });
  assert.equal(rev2.revision, 2);
  const source2 = service.get({ previewId: created.previewId, revision: 2, mode: 'source' });
  assert.equal(source2.css, 'a{}');
  assert.equal(source2.js, 'x()');
  assert.equal(source2.title, 'Title');

  const cleared = service.update({ previewId: created.previewId, expectedRevision: 2, title: '', css: '', js: '' });
  assert.equal(cleared.revision, 3);
  const source3 = service.get({ previewId: created.previewId, revision: 3, mode: 'source' });
  assert.equal(source3.title, null);
  assert.equal(source3.css, '');
  assert.equal(source3.js, '');

  const duplicate = service.update({ previewId: created.previewId, expectedRevision: 3, title: '', css: '', js: '' });
  assert.equal(duplicate.changed, false);
  assert.equal(duplicate.revision, 3);

  const reverted = service.update({ previewId: created.previewId, expectedRevision: 3, title: 'Title', html: '<main>a</main>', css: 'a{}', js: 'x()' });
  assert.equal(reverted.changed, true);
  assert.equal(reverted.revision, 4);
});

test('stale expectedRevision fails with the stable preview conflict code', () => {
  const created = service.create({ html: '<main>a</main>', spec });
  assert.throws(() => service.update({ previewId: created.previewId, expectedRevision: 99, html: '<main>b</main>' }), (error: any) => error?.code === 'UI_PREVIEW_REVISION_CONFLICT');
});

test('durable create/update idempotency replays the original logical revision after later mutations', () => {
  const first = service.create({ html: '<main>a</main>', spec, idempotencyKey: 'create-key' });
  const createReplay = service.create({ html: '<main>a</main>', spec, idempotencyKey: 'create-key' });
  assert.equal(createReplay.previewId, first.previewId);
  assert.equal(createReplay.revision, 1);

  const update = service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>b</main>', idempotencyKey: 'update-key' });
  service.update({ previewId: first.previewId, expectedRevision: 2, html: '<main>c</main>' });
  const delayedReplay = service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>b</main>', idempotencyKey: 'update-key' });
  assert.equal(delayedReplay.revision, update.revision);
  assert.equal(delayedReplay.replayed, true);
  assert.equal(repository.countRevisions(first.previewId), 3);
  assert.throws(() => service.update({ previewId: first.previewId, expectedRevision: 1, html: '<main>DIFFERENT</main>', idempotencyKey: 'update-key' }), (error: any) => error?.code === 'UI_PREVIEW_IDEMPOTENCY_CONFLICT');
});

test('library list resolves latest unpinned runtime URLs and returns summary metadata only', () => {
  const created = service.create({ title: 'Library', html: '<main>secret</main>', css: 'secret-css', js: 'secret-js', spec });
  service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>latest secret</main>' });
  const page = service.list({ filter: 'all', limit: 20 });
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].latestRevision, 2);
  assert.equal(page.items[0].specSummary.screen, 'Service');
  assert.match(page.items[0].latestPreviewUrl, /^http:\/\/127\.0\.0\.1:43123\/api\/ui-previews\//);
  assert.doesNotMatch(page.items[0].latestPreviewUrl, /revision=/);
  assert.doesNotMatch(JSON.stringify(page), /latest secret|secret-css|secret-js/);
});

test('delete removes standalone previews and rejects linked or missing previews', () => {
  const created = service.create({ html: '<main>delete</main>', spec });
  service.update({ previewId: created.previewId, expectedRevision: 1, html: '<main>delete-2</main>' });
  const removed = (service as any).delete({ previewId: created.previewId });
  assert.deepEqual(removed, { previewId: created.previewId, deleted: true, deletedRevisions: 2 });
  assert.equal(repository.getPreview(created.previewId), null);

  seedTask('task-linked-service');
  const linkedService = createUiPreviewService({
    repository,
    runtimePort: () => 43123,
    designContextService: { get: () => designContext({ taskId: 'task-linked-service' }) as any },
  });
  const linked = linkedService.create({
    taskId: 'task-linked-service',
    expectedDesignContextHash: 'a'.repeat(64),
    html: '<main>linked</main>',
    spec,
  });
  assert.throws(() => (service as any).delete({ previewId: linked.previewId }), (error: any) => error?.code === 'UI_PREVIEW_DELETE_LINKED_CONFLICT');
  assert.throws(() => (service as any).delete({ previewId: 'uip_missing_service' }), (error: any) => error?.code === 'UI_PREVIEW_NOT_FOUND');
});

test('create/update/get core does not depend on project workspace, git, verification, or playwright services', async () => {
  const source = fs.readFileSync(path.resolve('src/server/services/uiPreviewService.ts'), 'utf8');
  assert.doesNotMatch(source, /gitService|sessionWorkspace|projectWorkspace|runProjectCommand|playwright|screenshot/i);
});
