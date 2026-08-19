import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  composeUiPreviewDocument,
  composeUiPreviewWorkspaceDocument,
  materializeUiPreviewFonts,
  UI_PREVIEW_FONT_LIMITS,
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

function contentIdentity(bytes: Uint8Array) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function woff2Bytes(size = 32) {
  const bytes = Buffer.alloc(Math.max(4, size), 0x2a);
  bytes.set(Buffer.from('wOF2'), 0);
  return bytes;
}

function fontRef(bytes: Uint8Array, overrides: Record<string, any> = {}) {
  return {
    assetId: 'font_inter_400',
    kind: 'font',
    contentIdentity: contentIdentity(bytes),
    font: {
      family: 'Inter',
      weight: 400,
      style: 'normal',
      mimeType: 'font/woff2',
      byteLength: bytes.byteLength,
    },
    ...overrides,
  };
}

test('materializes current content-addressed WOFF2 font refs into immutable data-font snapshots', () => {
  const bytes = woff2Bytes();
  const ref = fontRef(bytes);
  const snapshot = materializeUiPreviewFonts({
    contextHash: 'a'.repeat(64),
    renderAssets: [ref],
    resolvedFonts: [{ assetId: ref.assetId, bytes }],
  });
  assert.equal(snapshot.fontRenderability, 'available');
  assert.equal(snapshot.unavailable.length, 0);
  assert.equal(snapshot.fonts[0].contentIdentity, ref.contentIdentity);
  assert.equal(snapshot.fonts[0].family, 'Inter');
  assert.equal(snapshot.fonts[0].weight, 400);
  assert.equal(snapshot.fonts[0].style, 'normal');
  assert.match(snapshot.fonts[0].dataUri, /^data:font\/woff2;base64,/);

  const document = composeUiPreviewDocument({
    html: '<main class="brand">Brand</main>',
    css: '.brand { font-family: Inter, sans-serif; font-weight: 400; }',
    fontSnapshot: snapshot,
  });
  assert.equal(document.csp, UI_PREVIEW_CSP);
  assert.equal(document.fontRenderability, 'available');
  assert.deepEqual(document.fontContentIdentities, [ref.contentIdentity]);
  assert.match(document.html, /@font-face/);
  assert.match(document.html, /font-family:\"Inter\"/);
  assert.match(document.html, /data:font\/woff2;base64,/);

  const acceptedHtml = document.html;
  bytes.fill(0);
  assert.equal(document.html, acceptedHtml, 'accepted document remains immutable after source bytes mutate');
  const stale = materializeUiPreviewFonts({
    contextHash: 'a'.repeat(64),
    renderAssets: [ref],
    resolvedFonts: [{ assetId: ref.assetId, bytes }],
  });
  assert.equal(stale.fontRenderability, 'unavailable');
  assert.equal(stale.unavailable[0]?.reasonCode, 'FONT_CONTENT_IDENTITY_MISMATCH');
});

test('rejects unsupported, oversize, and aggregate-oversize font materialization without injecting fallback claims', () => {
  const unsupportedBytes = woff2Bytes();
  const unsupported = materializeUiPreviewFonts({
    contextHash: 'b'.repeat(64),
    renderAssets: [fontRef(unsupportedBytes, { font: { family: 'Inter', weight: 400, style: 'normal', mimeType: 'font/ttf', byteLength: unsupportedBytes.byteLength } })],
    resolvedFonts: [{ assetId: 'font_inter_400', bytes: unsupportedBytes }],
  });
  assert.equal(unsupported.fontRenderability, 'unavailable');
  assert.equal(unsupported.unavailable[0]?.reasonCode, 'FONT_TYPE_UNSUPPORTED');
  assert.equal(unsupported.fonts.length, 0);

  const tooLargeBytes = woff2Bytes(UI_PREVIEW_FONT_LIMITS.maxAssetBytes + 1);
  const tooLargeRef = fontRef(tooLargeBytes);
  const tooLarge = materializeUiPreviewFonts({ contextHash: 'c'.repeat(64), renderAssets: [tooLargeRef], resolvedFonts: [{ assetId: tooLargeRef.assetId, bytes: tooLargeBytes }] });
  assert.equal(tooLarge.fontRenderability, 'unavailable');
  assert.equal(tooLarge.unavailable[0]?.reasonCode, 'FONT_ASSET_TOO_LARGE');

  const aggregateBytes = Array.from({ length: 4 }, (_, index) => woff2Bytes(Math.floor(UI_PREVIEW_FONT_LIMITS.maxAggregateBytes / 4) + 8));
  const aggregateRefs = aggregateBytes.map((bytes, index) => fontRef(bytes, { assetId: `font_inter_${index}` }));
  const aggregate = materializeUiPreviewFonts({
    contextHash: 'd'.repeat(64),
    renderAssets: aggregateRefs,
    resolvedFonts: aggregateRefs.map((ref, index) => ({ assetId: ref.assetId, bytes: aggregateBytes[index] })),
  });
  assert.equal(aggregate.fontRenderability, 'unavailable');
  assert.ok(aggregate.unavailable.some((entry) => entry.reasonCode === 'FONT_AGGREGATE_TOO_LARGE'));
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
