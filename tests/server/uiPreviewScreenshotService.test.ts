import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const artifactModule = await import('../../src/server/services/uiPreviewArtifactStore.js');
const screenshotModule = await import('../../src/server/services/uiPreviewScreenshotService.js');

const { createUiPreviewArtifactStore } = artifactModule;
const { createUiPreviewScreenshotService, isAllowedPreviewRequestUrl } = screenshotModule;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function createFakeBrowser(options: { screenshot?: Buffer; setContent?: () => Promise<void> } = {}) {
  const state = {
    contexts: 0,
    pages: 0,
    routePatterns: [] as string[],
    websocketRoutePatterns: [] as string[],
    routeHandler: null as null | ((route: any) => Promise<void>),
    websocketRouteHandler: null as null | ((route: any) => Promise<void>),
    initScripts: [] as string[],
    contextPageHandlers: 0,
    closedContexts: 0,
    setContentHtml: '',
    viewport: null as any,
    pageEvents: [] as string[],
  };
  const browser = {
    isConnected: () => true,
    on: () => {},
    newContext: async (contextOptions: any) => {
      state.contexts += 1;
      state.viewport = contextOptions.viewport;
      return {
        addInitScript: async (script: string) => { state.initScripts.push(script); },
        route: async (pattern: string, handler: (route: any) => Promise<void>) => {
          state.routePatterns.push(pattern);
          state.routeHandler = handler;
        },
        routeWebSocket: async (pattern: string, handler: (route: any) => Promise<void>) => {
          state.websocketRoutePatterns.push(pattern);
          state.websocketRouteHandler = handler;
        },
        on: (event: string, _handler: unknown) => {
          if (event === 'page') state.contextPageHandlers += 1;
        },
        newPage: async () => {
          state.pages += 1;
          return {
            on: (event: string, _handler: unknown) => { state.pageEvents.push(event); },
            setContent: async (html: string) => {
              state.setContentHtml = html;
              if (options.setContent) return options.setContent();
            },
            screenshot: async () => options.screenshot ?? PNG,
          };
        },
        close: async () => { state.closedContexts += 1; },
      };
    },
    close: async () => {},
  };
  return { browser, state };
}

async function runHttpRoute(handler: ((route: any) => Promise<void>) | null, url: string, navigation = false) {
  assert.ok(handler, 'expected context HTTP route handler');
  let action = '';
  await handler({
    request: () => ({
      url: () => url,
      isNavigationRequest: () => navigation,
    }),
    continue: async () => { action = 'continue'; },
    abort: async () => { action = 'abort'; },
  });
  return action;
}

test('request allowlist permits only inert document-local schemes', () => {
  for (const url of ['about:blank', 'data:image/png;base64,AA==', 'blob:null/123']) {
    assert.equal(isAllowedPreviewRequestUrl(url), true, url);
  }
  for (const url of ['http://127.0.0.1:5173/api/tasks', 'https://example.com/a.js', 'ws://localhost:3000', 'file:///C:/secret.txt', 'ftp://example.com/file']) {
    assert.equal(isAllowedPreviewRequestUrl(url), false, url);
  }
});

test('artifact store writes generated PNGs atomically under DevFlow-owned storage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-artifacts-'));
  try {
    const store = createUiPreviewArtifactStore({ rootDir: root });
    const saved = await store.writePng(PNG);
    assert.match(saved.artifactId, /^uisa_[a-f0-9]{32}$/);
    assert.equal(path.dirname(saved.absolutePath), path.resolve(root));
    assert.deepEqual(fs.readFileSync(saved.absolutePath), PNG);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);
    assert.equal(store.resolveArtifactPath(saved.artifactId), saved.absolutePath);
    assert.throws(() => store.resolveArtifactPath('../outside'), /invalid ui preview artifact id/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('captures composed preview with context-wide HTTP/WebSocket guards and viewport metadata', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-capture-'));
  const fake = createFakeBrowser();
  try {
    const service = createUiPreviewScreenshotService({
      artifactStore: createUiPreviewArtifactStore({ rootDir: root }),
      browserFactory: async () => fake.browser as any,
    });
    const result = await service.capture({
      html: '<main>preview</main>',
      css: 'main { color: red; }',
      js: 'document.body.dataset.loaded = "yes";',
      viewport: { width: 640, height: 480, deviceScaleFactor: 2 },
    });

    assert.deepEqual(result.viewport, { width: 640, height: 480, deviceScaleFactor: 2 });
    assert.equal(result.png.byteLength, PNG.byteLength);
    assert.deepEqual(result.png.subarray(0, 8), PNG.subarray(0, 8));
    assert.equal(fs.existsSync(result.absolutePath), true);
    assert.equal(fake.state.contexts, 1);
    assert.equal(fake.state.closedContexts, 1);
    assert.equal(fake.state.initScripts.length, 1);
    assert.match(fake.state.initScripts[0], /RTCPeerConnection/);
    assert.deepEqual(fake.state.viewport, { width: 640, height: 480 });
    assert.match(fake.state.setContentHtml, /^<!doctype html>/i);
    assert.match(fake.state.setContentHtml, /<main>preview<\/main>/);
    assert.deepEqual(fake.state.routePatterns, ['**/*']);
    assert.deepEqual(fake.state.websocketRoutePatterns, ['**/*']);
    assert.equal(fake.state.contextPageHandlers, 1);
    assert.ok(fake.state.pageEvents.includes('download'));
    assert.ok(fake.state.pageEvents.includes('dialog'));

    assert.equal(await runHttpRoute(fake.state.routeHandler, 'https://example.com/a.js'), 'abort');
    assert.equal(await runHttpRoute(fake.state.routeHandler, 'file:///C:/secret.txt'), 'abort');
    assert.equal(await runHttpRoute(fake.state.routeHandler, 'data:image/png;base64,AA=='), 'continue');
    assert.equal(await runHttpRoute(fake.state.routeHandler, 'data:text/html,<script>bad()</script>', true), 'abort');

    let websocketClosed = false;
    assert.ok(fake.state.websocketRouteHandler, 'expected context WebSocket route handler');
    await fake.state.websocketRouteHandler({
      close: async () => { websocketClosed = true; },
    });
    assert.equal(websocketClosed, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('renderer unavailable is actionable without requiring Chromium at service construction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-unavailable-'));
  try {
    const service = createUiPreviewScreenshotService({
      artifactStore: createUiPreviewArtifactStore({ rootDir: root }),
      browserFactory: async () => { throw new Error("Executable doesn't exist at chromium"); },
    });
    await assert.rejects(
      () => service.capture({ html: '<p>x</p>', viewport: { width: 320, height: 240 } }),
      (error: any) => error?.code === 'UI_PREVIEW_RENDERER_UNAVAILABLE' && /npx playwright install chromium/.test(error.message),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hung preview content fails within the configured bounded capture timeout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-timeout-'));
  const fake = createFakeBrowser({ setContent: () => new Promise<void>(() => {}) });
  try {
    const service = createUiPreviewScreenshotService({
      artifactStore: createUiPreviewArtifactStore({ rootDir: root }),
      browserFactory: async () => fake.browser as any,
      captureTimeoutMs: 50,
    });
    await assert.rejects(
      () => service.capture({ html: '<script>while(true){}</script>', viewport: { width: 320, height: 240 } }),
      (error: any) => error?.code === 'UI_PREVIEW_CAPTURE_TIMEOUT',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('browser crash during capture invalidates the browser and retries once with a fresh launch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ui-preview-relaunch-'));
  const healthy = createFakeBrowser();
  let launches = 0;
  try {
    const service = createUiPreviewScreenshotService({
      artifactStore: createUiPreviewArtifactStore({ rootDir: root }),
      browserFactory: async () => {
        launches += 1;
        if (launches === 1) {
          return {
            isConnected: () => false,
            on: () => {},
            newContext: async () => { throw new Error('Target page, context or browser has been closed'); },
            close: async () => {},
          } as any;
        }
        return healthy.browser as any;
      },
    });
    const result = await service.capture({ html: '<p>retry</p>', viewport: { width: 320, height: 240 } });
    assert.equal(launches, 2);
    assert.equal(result.png.byteLength, PNG.byteLength);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
