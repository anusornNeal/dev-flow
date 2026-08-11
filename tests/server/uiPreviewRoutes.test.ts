import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import express from 'express';
import { registerUiPreviewRoutes } from '../../src/server/routes/uiPreviews.js';
import { evaluateStrictLoopbackAccess } from '../../src/server/services/apiAccessPolicyService.js';

function loadPlaywrightForPcSmoke(): any | null {
  const roots = new Set<string>();
  try {
    const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: process.cwd(), encoding: 'utf8' }).trim();
    roots.add(path.dirname(path.resolve(process.cwd(), gitCommonDir)));
  } catch {}
  for (const entry of String(process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    if (path.basename(entry).toLowerCase() !== '.bin') continue;
    const nodeModules = path.dirname(entry);
    if (path.basename(nodeModules).toLowerCase() !== 'node_modules') continue;
    roots.add(path.dirname(nodeModules));
  }
  for (const root of roots) {
    try {
      return createRequire(path.join(root, 'package.json'))('playwright');
    } catch {}
  }
  return null;
}

const pcSmokePlaywright = loadPlaywrightForPcSmoke();

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-routes-'));
const artifactId = `uisa_${'a'.repeat(32)}`;
const artifactPath = path.join(tempRoot, `${artifactId}.png`);
fs.writeFileSync(artifactPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]));

const source = {
  previewId: 'uip_route',
  taskId: null,
  revision: 2,
  latestRevision: 2,
  title: 'Route preview',
  html: '<main id="route-preview">hello</main>',
  css: 'main{display:block}',
  js: 'window.previewRan=true',
  viewport: { width: 800, height: 600, deviceScaleFactor: 1 },
  spec: { schemaVersion: 1, summary: { screen: 'Route preview' } },
  specSummary: { screen: 'Route preview' },
  contentHash: 'hash',
  previewUrl: 'http://127.0.0.1:45555/api/ui-previews/uip_route/document?revision=2',
};

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  const previewService = {
    create: (input: any) => ({ previewId: 'uip_route', revision: 1, latestRevision: 1, changed: true, ...input }),
    update: (input: any) => ({ previewId: input.previewId, revision: 2, latestRevision: 2, changed: true }),
    get: (input: any) => input.mode === 'source' ? source : { ...source, html: undefined, css: undefined, js: undefined, spec: undefined },
  };
  const evidenceService = {
    list: (input: any) => ({ items: [{ evidenceId: 'uie_1', previewId: 'uip_route', frozenRevision: 2 }], nextCursor: null, limit: Math.min(50, input.limit || 20) }),
    attach: async (input: any) => ({ evidenceId: 'uie_1', taskId: input.taskId, previewId: input.previewId, frozenRevision: input.revision || 2 }),
  };
  const artifactStore = {
    rootDir: tempRoot,
    writePng: async () => { throw new Error('not used'); },
    resolveArtifactPath: (id: string) => {
      if (id !== artifactId) throw new Error('Invalid UI preview artifact id.');
      return artifactPath;
    },
  };
  registerUiPreviewRoutes(app, { state: { countersCache: {} }, writeAgentLog: () => {} } as any, { previewService, evidenceService, artifactStore } as any);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test.after(() => {
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

test('strict preview access requires direct loopback and every forwarded hop to be loopback', () => {
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1' }).allowed, true);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '::1' }).allowed, true);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '::ffff:127.0.0.9' }).allowed, true);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '10.0.0.5' }).allowed, false);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwardedFor: '127.0.0.1, 203.0.113.9' }).allowed, false);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwarded: 'for=127.0.0.1, for="[::1]"' }).allowed, true);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwarded: 'for=unknown' }).allowed, false);
  assert.equal(evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwarded: 'proto=http' }).allowed, false);
});

test('document and screenshot routes are local-only, no-store, and ignore Host as authorization input', async () => {
  await withServer(async (baseUrl) => {
    const local = await fetch(`${baseUrl}/api/ui-previews/uip_route/document?revision=2`, { headers: { Host: 'attacker.example' } });
    assert.equal(local.status, 200);
    assert.match(await local.text(), /route-preview/);
    assert.match(local.headers.get('cache-control') || '', /no-store/);
    assert.match(local.headers.get('content-security-policy') || '', /sandbox/);

    const forwardedRemote = await fetch(`${baseUrl}/api/ui-previews/uip_route/document`, { headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.9' } });
    assert.equal(forwardedRemote.status, 403);

    const malformedForwarded = await fetch(`${baseUrl}/api/ui-previews/uip_route/document`, { headers: { forwarded: 'for=unknown' } });
    assert.equal(malformedForwarded.status, 403);

    const screenshot = await fetch(`${baseUrl}/api/ui-preview-artifacts/${artifactId}`);
    assert.equal(screenshot.status, 200);
    assert.equal(screenshot.headers.get('content-type'), 'image/png');
    assert.match(screenshot.headers.get('cache-control') || '', /no-store/);

    const badArtifact = await fetch(`${baseUrl}/api/ui-preview-artifacts/uisa_bad`);
    assert.equal(badArtifact.status, 400);

    const traversalArtifact = await fetch(`${baseUrl}/api/ui-preview-artifacts/${encodeURIComponent('../secret.png')}`);
    assert.ok([400, 404].includes(traversalArtifact.status));
  });
});

test('control and evidence routes preserve summary/source and bounded paging shapes', async () => {
  await withServer(async (baseUrl) => {
    const summary = await fetch(`${baseUrl}/api/ui-previews/uip_route?mode=summary`);
    assert.equal(summary.status, 200);
    const summaryBody = await summary.json() as any;
    assert.equal('html' in summaryBody, false);

    const sourceResponse = await fetch(`${baseUrl}/api/ui-previews/uip_route?revision=2&mode=source`);
    const sourceBody = await sourceResponse.json() as any;
    assert.equal(sourceBody.html, source.html);

    const page = await fetch(`${baseUrl}/api/tasks/DVF-0485/ui-evidence?limit=999`);
    const pageBody = await page.json() as any;
    assert.equal(pageBody.limit, 50);

    const attached = await fetch(`${baseUrl}/api/tasks/DVF-0485/ui-evidence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ previewId: 'uip_route', revision: 2, idempotencyKey: 'route-attach' }),
    });
    assert.equal(attached.status, 200);
    assert.equal((await attached.json() as any).frozenRevision, 2);
  });
});

test('PC smoke uses real Chromium to create, update, attach, freeze screenshot evidence, then observe a newer latest revision', { timeout: 20000, skip: pcSmokePlaywright ? false : 'Playwright runtime is not installed for this verification process.' }, async () => {
  const BetterSqlite3 = (await import('better-sqlite3')).default;
  const { initMigration } = await import('../../src/db/migrations/001-init.js');
  const { uiPreviewsMigration } = await import('../../src/db/migrations/016-ui-previews.js');
  const { createUiPreviewRepository } = await import('../../src/server/repositories/uiPreviewRepository.js');
  const { createTaskUiEvidenceRepository } = await import('../../src/server/repositories/taskUiEvidenceRepository.js');
  const { createUiPreviewService } = await import('../../src/server/services/uiPreviewService.js');
  const { createTaskUiEvidenceService } = await import('../../src/server/services/taskUiEvidenceService.js');
  const { createUiPreviewArtifactStore } = await import('../../src/server/services/uiPreviewArtifactStore.js');
  const { createUiPreviewScreenshotService } = await import('../../src/server/services/uiPreviewScreenshotService.js');

  const smokeDbPath = path.join(tempRoot, 'pc-smoke.db');
  const smokeDb = new BetterSqlite3(smokeDbPath);
  smokeDb.pragma('foreign_keys = ON');
  initMigration.up(smokeDb as any);
  uiPreviewsMigration.up(smokeDb as any);
  smokeDb.prepare('INSERT INTO tasks (id, displayId, title, status) VALUES (?, ?, ?, ?)')
    .run('task-pc-smoke', 'DVF-PC-SMOKE', 'PC smoke', 'todo');

  const previewRepository = createUiPreviewRepository(smokeDb as any);
  const evidenceRepository = createTaskUiEvidenceRepository(smokeDb as any);
  const artifactStore = createUiPreviewArtifactStore({ rootDir: path.join(tempRoot, 'pc-smoke-artifacts') });
  const chromium = pcSmokePlaywright!.chromium;
  const screenshotService = createUiPreviewScreenshotService({
    artifactStore,
    browserFactory: () => chromium.launch({ headless: true }),
  });
  const previews = createUiPreviewService({ repository: previewRepository, runtimePort: () => 45555, createId: () => 'uip_pc_smoke' });
  const evidence = createTaskUiEvidenceService({
    database: smokeDb as any,
    previewRepository,
    evidenceRepository,
    screenshotService,
    runtimePort: () => 45555,
    createEvidenceId: () => 'uie_pc_smoke',
    resolveTaskId: (identifier) => identifier === 'task-pc-smoke' || identifier === 'DVF-PC-SMOKE' ? 'task-pc-smoke' : null,
  });

  try {
    const created = previews.create({ html: '<main id="smoke">rev1</main>', spec: { schemaVersion: 1, summary: { screen: 'PC smoke' } } });
    previews.update({ previewId: created.previewId, expectedRevision: 1, html: '<main id="smoke">rev2</main>' });
    const frozen = await evidence.attach({ taskId: 'DVF-PC-SMOKE', previewId: created.previewId, revision: 2, idempotencyKey: 'pc-smoke-attach' });
    assert.equal(frozen.frozenRevision, 2);
    assert.equal(frozen.latestRevision, 2);
    const artifact = frozen.screenshotUrl.split('/').at(-1)!;
    assert.equal(fs.existsSync(artifactStore.resolveArtifactPath(artifact)), true);

    previews.update({ previewId: created.previewId, expectedRevision: 2, html: '<main id="smoke">rev3</main>' });
    const page = evidence.list({ taskId: 'DVF-PC-SMOKE', limit: 20 });
    assert.equal(page.items[0].frozenRevision, 2);
    assert.equal(page.items[0].latestRevision, 3);
    assert.match(page.items[0].frozenPreviewUrl, /revision=2/);
    assert.doesNotMatch(page.items[0].latestPreviewUrl, /revision=/);
  } finally {
    await screenshotService.close();
    smokeDb.close();
  }
});
