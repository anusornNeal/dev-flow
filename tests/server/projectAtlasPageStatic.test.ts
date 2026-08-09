import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pageSource = fs.readFileSync(new URL('../../src/components/ProjectAtlasPage.tsx', import.meta.url), 'utf8');
const headerSource = fs.readFileSync(new URL('../../src/components/Header.tsx', import.meta.url), 'utf8');

test('ProjectAtlasPage does not expose manual local Atlas build controls', () => {
  assert.equal(pageSource.includes('/api/project-atlas/rescan'), false);
  assert.equal(pageSource.includes('Manual Rescan'), false);
  assert.equal(pageSource.includes('Rescan'), false);
  assert.match(pageSource, /ask ChatGPT to build or update/i);
});

test('ProjectAtlasPage leaves Atlas page identity to the global header and keeps only Atlas controls', () => {
  assert.doesNotMatch(pageSource, /<h1[\s\S]*?Project Atlas[\s\S]*?<\/h1>/);
  assert.doesNotMatch(pageSource, /\bWaypoints\b/);
  assert.match(pageSource, /FILTERS\.map/);
  assert.match(pageSource, /<AtlasSearchBar/);
  assert.match(headerSource, /sticky top-0 z-\[50\]/);
});

test('Atlas header and toolbar keep responsive wrapping with global header above page controls', () => {
  assert.match(headerSource, /flex flex-col md:flex-row/);
  assert.match(headerSource, /items-start md:items-center sticky top-0 z-\[50\]/);
  assert.match(pageSource, /relative z-20 shrink-0/);
  assert.match(pageSource, /role="toolbar"[\s\S]*?flex flex-wrap items-center/);
  assert.match(pageSource, /flex min-w-0 flex-1 flex-wrap items-center/);
  assert.match(pageSource, /flex min-w-0 flex-wrap gap-1\.5/);
});
