import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pageSource = fs.readFileSync(new URL('../../src/components/ProjectAtlasPage.tsx', import.meta.url), 'utf8');

test('ProjectAtlasPage does not expose manual local Atlas build controls', () => {
  assert.equal(pageSource.includes('/api/project-atlas/rescan'), false);
  assert.equal(pageSource.includes('Manual Rescan'), false);
  assert.equal(pageSource.includes('Rescan'), false);
  assert.match(pageSource, /ask ChatGPT to build or update/i);
});
