import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeUiPreviewDocument,
  composeUiPreviewWorkspaceDocument,
  UI_PREVIEW_CSP,
  UI_PREVIEW_WORKSPACE_CSP,
} from '../../src/server/services/uiPreviewDocumentService.js';

test('legacy preview document keeps direct body rendering and capability guard', () => {
  const document = composeUiPreviewDocument({
    title: 'Legacy preview',
    html: '<main id="legacy-screen">Legacy</main>',
    css: 'main{display:block}',
    js: 'window.legacyRan=true',
  });

  assert.equal(document.csp, UI_PREVIEW_CSP);
  assert.match(document.html, /id="legacy-screen"/);
  assert.match(document.html, /window\.legacyRan=true/);
  assert.doesNotMatch(document.html, /data-ui-preview-workspace/);
  assert.doesNotMatch(document.html, /<iframe/);
});

test('workspace document keeps server-owned navigator outside selected screen sandbox', () => {
  const document = composeUiPreviewWorkspaceDocument({
    title: 'Checkout flow',
    selectedScreenId: 'details',
    screens: [
      {
        screenId: 'overview',
        name: 'Overview',
        href: '/api/ui-previews/uip_demo/document?revision=4&screenId=overview',
        html: '<main id="overview-screen">Overview</main>',
        css: '',
        js: '',
      },
      {
        screenId: 'details',
        name: 'Details & confirm',
        href: '/api/ui-previews/uip_demo/document?revision=4&screenId=details',
        html: '<main id="details-screen">Details</main>',
        css: 'main{font-weight:700}',
        js: 'window.selectedScreenRan=true',
      },
    ],
  });

  assert.equal(document.csp, UI_PREVIEW_WORKSPACE_CSP);
  assert.match(document.html, /data-ui-preview-workspace/);
  assert.match(document.html, /aria-label="Preview screens"/);
  assert.match(document.html, /aria-current="page"[^>]*>Details &amp; confirm/);
  assert.match(document.html, /Selected<\/span>/);
  assert.match(document.html, /<iframe[^>]*sandbox="allow-scripts"/);
  assert.doesNotMatch(document.html, /allow-same-origin/);
  assert.match(document.html, /id=&quot;details-screen&quot;/);
  assert.match(document.html, /window\.selectedScreenRan=true/);
  assert.doesNotMatch(document.html, /id=&quot;overview-screen&quot;/);
  assert.match(document.html, /screenId=overview/);
  assert.match(document.html, /screenId=details/);
});

test('workspace navigator escapes screen labels and link attributes', () => {
  const document = composeUiPreviewWorkspaceDocument({
    title: '<Workspace>',
    selectedScreenId: 'main',
    screens: [{
      screenId: 'main',
      name: '<Main "screen">',
      href: '/preview?screenId=main&revision=1',
      html: '<main>Safe source</main>',
      css: '',
      js: '',
    }],
  });

  assert.match(document.html, /&lt;Main &quot;screen&quot;&gt;/);
  assert.match(document.html, /screenId=main&amp;revision=1/);
  assert.doesNotMatch(document.html, /<Main "screen">/);
});
