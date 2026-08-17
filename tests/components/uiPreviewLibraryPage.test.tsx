import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import UiPreviewLibraryPage from '../../src/components/UiPreviewLibraryPage.js';

const sample = {
  previewId: 'uip-1',
  taskId: null,
  title: 'Checkout concept',
  specSummary: { screen: 'Checkout' },
  screenCount: 3,
  defaultScreenId: 'checkout',
  defaultScreenSummary: { screenId: 'checkout', name: 'Checkout', specSummary: { screen: 'Checkout' } },
  latestRevision: 4,
  createdAt: '2026-08-11T01:00:00.000Z',
  updatedAt: '2026-08-11T02:00:00.000Z',
  latestPreviewUrl: 'http://127.0.0.1:3000/api/ui-previews/uip-1/document',
  linkedTask: null,
};

test('library surface clearly communicates global/latest semantics and core actions', () => {
  const html = renderToStaticMarkup(React.createElement(UiPreviewLibraryPage as any, {
    initialItems: [sample],
    disableAutoLoad: true,
    onOpenTask: () => {},
  }));
  assert.match(html, /UI Previews/);
  assert.match(html, /Global/);
  assert.match(html, /All local previews/);
  assert.match(html, />All</);
  assert.match(html, />Standalone</);
  assert.match(html, />Linked</);
  assert.match(html, /Latest rev 4/);
  assert.match(html, /3 screens/);
  assert.match(html, /Default Checkout/);
  assert.match(html, /Open Latest Preview/);
  assert.match(html, /Copy Latest Link/);
  assert.match(html, /Attach to Task/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /Delete/);
  assert.doesNotMatch(html, />uip-1</);
});

test('linked item keeps library presence and exposes task context/open action', () => {
  const linked = { ...sample, taskId: 'task-1', linkedTask: { id: 'task-1', displayId: 'DVF-0502', title: 'Preview card', projectId: 'project-b' } };
  const html = renderToStaticMarkup(React.createElement(UiPreviewLibraryPage as any, {
    initialItems: [linked],
    disableAutoLoad: true,
    onOpenTask: () => {},
  }));
  assert.match(html, /DVF-0502/);
  assert.match(html, /Preview card/);
  assert.match(html, /Open Task/);
  assert.doesNotMatch(html, /Attach to Task/);
  assert.doesNotMatch(html, /Delete/);
});

test('single-screen and legacy previews avoid noisy screen-count copy', () => {
  const singleScreen = renderToStaticMarkup(React.createElement(UiPreviewLibraryPage as any, {
    initialItems: [{ ...sample, screenCount: 1, defaultScreenId: 'main', defaultScreenSummary: { screenId: 'main', name: 'Checkout', specSummary: { screen: 'Checkout' } } }],
    disableAutoLoad: true,
    onOpenTask: () => {},
  }));
  assert.doesNotMatch(singleScreen, /1 screen/);

  const legacy = renderToStaticMarkup(React.createElement(UiPreviewLibraryPage as any, {
    initialItems: [{ ...sample, screenCount: null, defaultScreenId: null, defaultScreenSummary: null }],
    disableAutoLoad: true,
    onOpenTask: () => {},
  }));
  assert.doesNotMatch(legacy, /screens/);
});

test('untitled previews use a neutral label instead of exposing internal ids', () => {
  const html = renderToStaticMarkup(React.createElement(UiPreviewLibraryPage as any, {
    initialItems: [{ ...sample, previewId: 'uip-secret-internal', title: null, specSummary: {} }],
    disableAutoLoad: true,
    onOpenTask: () => {},
  }));
  assert.match(html, /Untitled preview/);
  assert.doesNotMatch(html, />uip-secret-internal</);
});

test('library source uses explicit delete confirmation and silent preview-event refresh without clearing cards', () => {
  const component = fs.readFileSync('src/components/UiPreviewLibraryPage.tsx', 'utf8');
  assert.match(component, /subscribeServerEvents/);
  assert.match(component, /ui-preview\.changed/);
  assert.match(component, /window\.confirm/);
  assert.match(component, /deleteUiPreview/);
  assert.match(component, /background/);
  const refreshStart = component.indexOf('const refresh');
  const copyStart = component.indexOf('const copyLatest');
  assert.ok(refreshStart >= 0 && copyStart > refreshStart);
  assert.doesNotMatch(component.slice(refreshStart, copyStart), /setItems\(\[\]\)/);
});

test('preview library re-arms its mounted guard when StrictMode replays mount effects', () => {
  const component = fs.readFileSync('src/components/UiPreviewLibraryPage.tsx', 'utf8');
  const setupIndex = component.indexOf('mounted.current = true');
  const cleanupIndex = component.indexOf('mounted.current = false');

  assert.ok(setupIndex >= 0, 'mount effect setup must restore mounted.current before async requests settle');
  assert.ok(cleanupIndex >= 0, 'unmount cleanup must still mark the component unmounted');
  assert.ok(setupIndex < cleanupIndex, 'StrictMode replay requires setup to re-arm the mounted guard before cleanup can clear it');
});

test('App and Sidebar use direct #previews history navigation without resurrecting Atlas UI', () => {
  const app = fs.readFileSync('src/App.tsx', 'utf8');
  const sidebar = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
  assert.match(app, /window\.location\.hash === '#previews'/);
  assert.match(app, /addEventListener\('hashchange'/);
  assert.match(app, /UiPreviewLibraryPage/);
  assert.match(app, /api\/tasks\/\$\{encodeURIComponent\(task\.id\)\}\?mode=standard/);
  assert.match(app, /setActiveProjectId\(task\.projectId\)/);
  assert.match(sidebar, /UI Previews/);
  assert.match(sidebar, /onSetActivePage/);
  assert.doesNotMatch(app + sidebar, /ProjectAtlasPage|Project Atlas|#atlas.*ProjectAtlasPage/);
});
