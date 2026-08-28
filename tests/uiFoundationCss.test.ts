import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8');

test('uses LINE Seed Sans TH for normal UI while keeping JetBrains Mono technical', () => {
  assert.match(css, /--font-sans:\s*"LINE Seed Sans TH"/);
  assert.match(css, /--font-mono:\s*"JetBrains Mono"/);
  assert.doesNotMatch(css, /--font-sans:\s*"JetBrains Mono"/);
});

test('uses compact density tokens for the desktop workbench', () => {
  assert.match(css, /--df-space-2:\s*6px/);
  assert.match(css, /--df-control-height-compact:\s*30px/);
  assert.match(css, /--df-control-height:\s*36px/);
  assert.match(css, /--df-radius-sm:\s*6px/);
  assert.match(css, /--df-radius-md:\s*8px/);
});

test('uses neutral light and graphite dark surfaces rather than brown-dominant layers', () => {
  assert.match(css, /--df-color-canvas:\s*#f7f7f8/);
  assert.match(css, /--df-color-surface:\s*#ffffff/);
  assert.match(css, /\.dark[\s\S]*--df-color-canvas:\s*#18191b/);
  assert.match(css, /\.dark[\s\S]*--df-color-surface:\s*#202124/);
});

test('defines explicit selected, disabled, focus and destructive shared interaction states', () => {
  assert.match(css, /\.df-control:focus-visible/);
  assert.match(css, /\.df-control\.is-selected/);
  assert.match(css, /\.df-button--danger/);
  assert.match(css, /\.df-button:disabled/);
});
