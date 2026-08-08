import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-metadata-'));
const { clearWorkspaceMetadataCache, getWorkspaceMetadataCacheStats, readWorkspaceMetadataFile } = await import('../../src/server/services/workspaceMetadataCacheService.js');

test.beforeEach(() => {
  clearWorkspaceMetadataCache();
});

test('workspace metadata cache reuses unchanged content and invalidates by file stat', () => {
  const filePath = path.join(tempDir, 'package.json');
  fs.writeFileSync(filePath, '{"value":1}', 'utf8');

  const first = readWorkspaceMetadataFile(filePath, 1000);
  const second = readWorkspaceMetadataFile(filePath, 1000);
  assert.equal(first?.cacheHit, false);
  assert.equal(second?.cacheHit, true);
  assert.equal(second?.content, first?.content);
  assert.equal(getWorkspaceMetadataCacheStats().hits, 1);

  fs.writeFileSync(filePath, '{"value":222}', 'utf8');
  const third = readWorkspaceMetadataFile(filePath, 1000);
  assert.equal(third?.cacheHit, false);
  assert.equal(third?.content, '{"value":222}');
});

test('workspace metadata cache returns null for missing files', () => {
  const missing = readWorkspaceMetadataFile(path.join(tempDir, 'missing.json'), 1000);
  assert.equal(missing, null);
});

test.after(() => {
  clearWorkspaceMetadataCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
