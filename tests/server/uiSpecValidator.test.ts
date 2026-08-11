import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UI_PREVIEW_LIMITS,
  normalizeUiPreviewInput,
  normalizeUiSpecV1,
} from '../../src/server/services/uiSpecValidator.js';

const spec = { schemaVersion: 1, summary: { screen: 'Dashboard' }, layout: { gap: 16 } };

test('normalizes UiSpecV1 recursively while preserving array order', () => {
  const normalized = normalizeUiSpecV1({
    z: { b: 2, a: 1 },
    summary: { screen: 'Dashboard' },
    schemaVersion: 1,
    items: [{ y: 2, x: 1 }, 'second'],
  });
  assert.deepEqual(Object.keys(normalized), ['items', 'schemaVersion', 'summary', 'z']);
  assert.deepEqual(Object.keys((normalized as any).z), ['a', 'b']);
  assert.deepEqual((normalized as any).items, [{ x: 1, y: 2 }, 'second']);
});

test('rejects invalid or non-json UiSpecV1 values', () => {
  assert.throws(() => normalizeUiSpecV1({ schemaVersion: 1, summary: {} }), /summary\.screen/i);
  assert.throws(() => normalizeUiSpecV1({ schemaVersion: 2, summary: { screen: 'A' } }), /schemaVersion/i);
  assert.throws(() => normalizeUiSpecV1({ schemaVersion: 1, summary: { screen: 'A' }, bad: Number.NaN }), /JSON/i);
  assert.throws(() => normalizeUiSpecV1({ schemaVersion: 1, summary: { screen: 'A' }, bad: undefined }), /JSON/i);
  assert.throws(() => normalizeUiSpecV1({ schemaVersion: 1, summary: { screen: 'A' }, bad: new Date() }), /JSON/i);
});

test('rejects complete outer documents and empty required html', () => {
  for (const html of ['<!doctype html><div>x</div>', '<html><div>x</div></html>', '<head></head><div>x</div>', '<body>x</body>']) {
    assert.throws(() => normalizeUiPreviewInput({ html, spec }), /fragment|outer document/i);
  }
  assert.throws(() => normalizeUiPreviewInput({ html: '', spec }), /html/i);
});

test('applies deterministic viewport defaults and validates bounds', () => {
  const normalized = normalizeUiPreviewInput({ html: '<main>ok</main>', spec });
  assert.deepEqual(normalized.viewport, { width: 1440, height: 900, deviceScaleFactor: 1 });
  assert.throws(() => normalizeUiPreviewInput({ html: '<main>ok</main>', spec, viewport: { width: 100, height: 900, deviceScaleFactor: 1 } }), /viewport/i);
  assert.throws(() => normalizeUiPreviewInput({ html: '<main>ok</main>', spec, viewport: { width: 1440, height: 900, deviceScaleFactor: 8 } }), /viewport/i);
});

test('enforces UTF-8 byte bounds without normalizing exact source strings', () => {
  const html = ' <main>ไทย\r\n</main> ';
  const normalized = normalizeUiPreviewInput({ html, css: ' a { } ', js: 'console.log("x")', title: '', spec });
  assert.equal(normalized.html, html);
  assert.equal(normalized.css, ' a { } ');
  assert.equal(normalized.title, null);
  assert.throws(() => normalizeUiPreviewInput({ html: 'x'.repeat(UI_PREVIEW_LIMITS.htmlBytes + 1), spec }), /byte|size/i);
  assert.throws(() => normalizeUiPreviewInput({ html: '<main>ok</main>', spec: { ...spec, huge: 'x'.repeat(UI_PREVIEW_LIMITS.specBytes + 1) } }), /byte|size/i);
});
