import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { UiPreviewDesignRenderAsset } from '../../src/server/domain/uiPreview.js';

const documentService = await import('../../src/server/services/uiPreviewDocumentService.js');

const { composeUiPreviewDocument, UI_PREVIEW_CSP } = documentService;

test('composes a DevFlow-owned outer document with a restrictive sandbox CSP', () => {
  const result = composeUiPreviewDocument({
    title: 'Preview',
    html: '<main id="content">Hello</main>',
    css: 'main { color: red; }',
    js: 'document.body.dataset.ready = "yes";',
  });

  assert.match(result.html, /^<!doctype html>/i);
  assert.match(result.html, /<main id="content">Hello<\/main>/);
  assert.equal(result.csp, UI_PREVIEW_CSP);
  assert.match(result.csp, /default-src 'none'/);
  assert.match(result.csp, /connect-src 'none'/);
  assert.match(result.csp, /form-action 'none'/);
  assert.match(result.csp, /object-src 'none'/);
  assert.match(result.csp, /frame-src 'none'/);
  assert.match(result.csp, /worker-src 'none'/);
  assert.match(result.csp, /base-uri 'none'/);
  assert.match(result.csp, /sandbox allow-scripts/);
  assert.doesNotMatch(result.csp, /allow-same-origin|allow-popups|allow-forms|allow-top-navigation/);
});

test('closing style and script sequences cannot escape DevFlow-owned elements', () => {
  const result = composeUiPreviewDocument({
    html: '<div>safe body</div>',
    css: 'body::after { content: "</style><script>globalThis.__escaped = true</script>"; }',
    js: 'globalThis.payload = "</script><img src=x onerror=alert(1)>";',
  });

  const styleBody = result.html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const scriptBodies = [...result.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const scriptBody = scriptBodies.at(-1) ?? '';
  assert.equal(styleBody.includes('</style>'), false);
  assert.equal(scriptBody.includes('</script>'), false);
  assert.match(styleBody, /<\\\/style>/i);
  assert.match(scriptBody, /<\\\/script>/i);
});

test('font materialization cannot widen CSP, use paths or URLs, or materialize stale/non-font refs', () => {
  const bytes = Buffer.from([...Buffer.from('wOF2'), 1, 2, 3, 4]);
  const identity = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const safeRef = {
    assetId: 'font_safe',
    kind: 'font',
    contentIdentity: identity,
    font: { family: 'Inter', weight: 400, style: 'normal', mimeType: 'font/woff2', byteLength: bytes.byteLength },
  } satisfies UiPreviewDesignRenderAsset;
  const snapshot = documentService.materializeUiPreviewFonts({
    contextHash: 'e'.repeat(64),
    renderAssets: [safeRef],
    resolvedFonts: [{ assetId: safeRef.assetId, bytes, path: 'C:\\secret\\font.woff2', url: 'https://evil.example/font.woff2' } as any],
  });
  const rendered = composeUiPreviewDocument({ html: '<main>Safe</main>', css: '', js: '', fontSnapshot: snapshot });
  assert.equal(rendered.csp, UI_PREVIEW_CSP);
  assert.match(rendered.csp, /font-src data:/);
  assert.match(rendered.csp, /connect-src 'none'/);
  assert.match(rendered.csp, /frame-src 'none'/);
  assert.match(rendered.csp, /img-src data: blob:/);
  assert.doesNotMatch(rendered.csp, /font-src[^;]*(?:https?:|file:|blob:)/);
  assert.doesNotMatch(rendered.html, /C:\\secret|evil\.example/);

  const stale = documentService.materializeUiPreviewFonts({
    contextHash: 'f'.repeat(64),
    renderAssets: [{ ...safeRef, contentIdentity: `sha256:${'0'.repeat(64)}` }],
    resolvedFonts: [{ assetId: safeRef.assetId, bytes }],
  });
  assert.equal(stale.fontRenderability, 'unavailable');
  assert.equal(stale.unavailable[0]?.reasonCode, 'FONT_CONTENT_IDENTITY_MISMATCH');

  const nonFont = documentService.materializeUiPreviewFonts({
    contextHash: '1'.repeat(64),
    renderAssets: [{ ...safeRef, kind: 'image' }],
    resolvedFonts: [{ assetId: safeRef.assetId, bytes }],
  });
  assert.equal(nonFont.fontRenderability, 'unavailable');
  assert.equal(nonFont.unavailable[0]?.reasonCode, 'FONT_REF_UNAUTHORIZED');

  const pathLike = documentService.materializeUiPreviewFonts({
    contextHash: '2'.repeat(64),
    renderAssets: [{ ...safeRef, assetId: '../secret' }],
    resolvedFonts: [{ assetId: '../secret', bytes }],
  });
  assert.equal(pathLike.fontRenderability, 'unavailable');
  assert.equal(pathLike.unavailable[0]?.reasonCode, 'FONT_REF_INVALID');
});


test('composer does not accept caller-owned document wrappers as a separate trusted surface', () => {
  const result = composeUiPreviewDocument({
    title: '</title><script>bad()</script>',
    html: '<section>body fragment</section>',
    css: '',
    js: '',
  });

  assert.equal((result.html.match(/<!doctype html>/gi) ?? []).length, 1);
  assert.equal((result.html.match(/<html/gi) ?? []).length, 1);
  assert.match(result.html, /&lt;\/title&gt;&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
