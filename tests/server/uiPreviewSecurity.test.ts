import test from 'node:test';
import assert from 'node:assert/strict';

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
