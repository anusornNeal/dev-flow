import test from 'node:test';
import assert from 'node:assert/strict';
import { openIsolatedDatabase } from '../../src/db/index.js';
import { DEVFLOW_MIGRATIONS } from '../../src/db/migrations/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';
import { getMcpToolList, getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';
import { normalizeUiPreviewInput } from '../../src/server/services/uiSpecValidator.js';
import { resolveUiPreviewUrl } from '../../src/server/services/uiPreviewUrlResolver.js';

const names = ['create_ui_preview', 'update_ui_preview', 'get_ui_preview', 'attach_ui_preview_to_task'] as const;

test('UI preview tools are exposed in full and coding profiles with bounded source semantics', () => {
  const full = new Set(getMcpToolList('full').map((tool: any) => tool.name));
  const coding = new Set(getMcpToolList('coding').map((tool: any) => tool.name));
  for (const name of names) {
    assert.equal(full.has(name), true, `${name} must be in full profile`);
    assert.equal(coding.has(name), true, `${name} must be in coding profile`);
  }

  const create = getToolDefinitionByName('create_ui_preview')!;
  assert.ok(create);
  assert.ok(create.inputSchema.properties.idempotencyKey);
  assert.ok(create.inputSchema.properties.screens);
  assert.ok(create.inputSchema.properties.defaultScreenId);
  assert.ok(Array.isArray(create.inputSchema.oneOf));
  const createRequest = create.buildHttpRequest({ html: '<main>x</main>', spec: { schemaVersion: 1, summary: { screen: 'X' } }, idempotencyKey: 'create-1' });
  assert.equal(createRequest.method, 'POST');
  assert.equal(createRequest.path, '/api/ui-previews');
  assert.equal((createRequest.body as any).idempotencyKey, 'create-1');

  const update = getToolDefinitionByName('update_ui_preview')!;
  assert.ok(update.inputSchema.properties.idempotencyKey);
  assert.ok(update.inputSchema.properties.screens);
  assert.ok(update.inputSchema.properties.defaultScreenId);
  const updateRequest = update.buildHttpRequest({ previewId: 'uip_demo', expectedRevision: 2, html: '<main>y</main>', idempotencyKey: 'update-1' });
  assert.equal(updateRequest.method, 'PUT');
  assert.equal(updateRequest.path, '/api/ui-previews/uip_demo');
  assert.equal((updateRequest.body as any).previewId, undefined);

  const get = getToolDefinitionByName('get_ui_preview')!;
  const summaryRequest = get.buildHttpRequest({ previewId: 'uip_demo' });
  assert.equal(summaryRequest.method, 'GET');
  assert.equal(summaryRequest.path, '/api/ui-previews/uip_demo?mode=summary');
  const sourceRequest = get.buildHttpRequest({ previewId: 'uip_demo', revision: 2, mode: 'source' });
  assert.match(sourceRequest.path, /revision=2/);
  assert.match(sourceRequest.path, /mode=source/);

  const attach = getToolDefinitionByName('attach_ui_preview_to_task')!;
  assert.ok(attach.inputSchema.properties.idempotencyKey);
  assert.ok(attach.inputSchema.properties.primaryScreenId);
  const attachRequest = attach.buildHttpRequest({ taskId: 'DVF-0485', previewId: 'uip_demo', revision: 2, primaryScreenId: 'details', idempotencyKey: 'attach-1' });
  assert.equal(attachRequest.method, 'POST');
  assert.equal(attachRequest.path, '/api/tasks/DVF-0485/ui-evidence');
  assert.deepEqual(attachRequest.body, { previewId: 'uip_demo', revision: 2, primaryScreenId: 'details', idempotencyKey: 'attach-1' });
});

test('multi-screen workspace validator pins canonical and legacy compatibility rules', () => {
  const legacy = normalizeUiPreviewInput({
    title: 'Legacy title',
    html: '<main>legacy</main>',
    spec: { schemaVersion: 1, summary: { screen: 'Legacy screen' } },
  });
  assert.equal(legacy.defaultScreenId, 'main');
  assert.deepEqual(legacy.screens.map(({ screenId, name }) => ({ screenId, name })), [{ screenId: 'main', name: 'Legacy screen' }]);

  const canonical = normalizeUiPreviewInput({
    screens: [
      { screenId: 'overview', name: 'Overview', html: '<main>one</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Overview' } } },
      { screenId: 'details', name: 'Details', html: '<main>two</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Details' } } },
    ],
  });
  assert.equal(canonical.defaultScreenId, 'overview');
  assert.equal(canonical.html, '<main>one</main>');
  assert.deepEqual(canonical.screens.map((screen) => screen.screenId), ['overview', 'details']);

  assert.throws(() => normalizeUiPreviewInput({
    html: '<main>legacy</main>',
    spec: { schemaVersion: 1, summary: { screen: 'Legacy' } },
    screens: [{ screenId: 'other', name: 'Other', html: '<main>other</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Other' } } }],
  }), /mixed|cannot be mixed/i);
  assert.throws(() => normalizeUiPreviewInput({ screens: [] }), /non-empty/i);
  assert.throws(() => normalizeUiPreviewInput({
    screens: [
      { screenId: 'same', name: 'One', html: '<main>one</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'One' } } },
      { screenId: 'same', name: 'Two', html: '<main>two</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Two' } } },
    ],
  }), /unique screenId/i);
  assert.throws(() => normalizeUiPreviewInput({
    defaultScreenId: 'missing',
    screens: [{ screenId: 'main', name: 'Main', html: '<main>x</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Main' } } }],
  }), /defaultScreenId/i);
  assert.throws(() => normalizeUiPreviewInput({
    screens: [{ screenId: '../escape', name: 'Bad', html: '<main>x</main>', css: '', js: '', spec: { schemaVersion: 1, summary: { screen: 'Bad' } } }],
  }), /URL-safe/i);
});

test('preview URL resolver deep-links only to safe opaque screen ids', () => {
  assert.equal(
    resolveUiPreviewUrl({ previewId: 'uip_demo', revision: 3, screenId: 'details-2', port: 4317 }),
    'http://127.0.0.1:4317/api/ui-previews/uip_demo/document?revision=3&screenId=details-2',
  );
  assert.throws(() => resolveUiPreviewUrl({ previewId: 'uip_demo', screenId: '../etc', port: 4317 }), /screenId/i);
});

test('migration 018 adds workspace CAS manifest and nullable primary screen without rewriting legacy evidence', () => {
  const database = openIsolatedDatabase(':memory:');
  try {
    runMigrations(database, [...DEVFLOW_MIGRATIONS]);
    const columns = database.prepare('PRAGMA table_info(task_ui_evidence)').all() as Array<{ name: string; notnull: number }>;
    const primaryScreen = columns.find((column) => column.name === 'primary_screen_id');
    assert.ok(primaryScreen);
    assert.equal(primaryScreen.notnull, 0);

    const manifestTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ui_preview_workspace_revision_manifests'").get() as { name: string } | undefined;
    assert.equal(manifestTable?.name, 'ui_preview_workspace_revision_manifests');
    const manifestColumns = database.prepare('PRAGMA table_info(ui_preview_workspace_revision_manifests)').all() as Array<{ name: string }>;
    assert.deepEqual(manifestColumns.map((column) => column.name), ['preview_id', 'revision', 'workspace_object_hash', 'created_at']);
  } finally {
    database.close();
  }
});
