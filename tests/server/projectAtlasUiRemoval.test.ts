import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appSource = fs.readFileSync('src/App.tsx', 'utf8');
const sidebarSource = fs.readFileSync('src/components/Sidebar.tsx', 'utf8');
const headerSource = fs.readFileSync('src/components/Header.tsx', 'utf8');
const projectRoutesSource = fs.readFileSync('src/server/routes/projects.ts', 'utf8');

test('Project Atlas browser UI is physically removed while backend Atlas stays separate', () => {
  assert.equal(fs.existsSync('src/components/ProjectAtlasPage.tsx'), false);
  assert.equal(fs.existsSync('src/components/projectAtlas'), false);
  assert.doesNotMatch(appSource, /ProjectAtlasPage|atlasEventRevision|activePage/);
  assert.doesNotMatch(sidebarSource, /Project Atlas|Waypoints|activePage|onSetActivePage/);
  assert.doesNotMatch(headerSource, /Project Atlas|activePage|knowledge graph/);
});

test('legacy Atlas browser route is removed without deleting agent-facing Atlas services', () => {
  assert.doesNotMatch(projectRoutesSource, /\/api\/projects\/:id\/atlas/);
  assert.equal(fs.existsSync('src/server/services/projectAtlasService.ts'), true);
  assert.equal(fs.existsSync('src/server/services/projectAtlasCacheService.ts'), true);
  assert.equal(fs.existsSync('src/server/services/projectAtlasImpactService.ts'), true);
});

test('legacy #atlas startup is normalized to the Board without a reload loop', () => {
  assert.match(appSource, /window\.location\.hash === '#atlas'/);
  assert.match(appSource, /window\.history\.replaceState/);
  assert.doesNotMatch(appSource, /addEventListener\('hashchange'/);
});
