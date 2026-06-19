import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-start-context-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { getProjectStartContext } = await import('../../src/server/services/projectStartContextService.js');

fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"fixture"}\n', 'utf8');
fs.writeFileSync(path.join(tempDir, 'README.md'), '# Fixture\n', 'utf8');
fs.mkdirSync(path.join(tempDir, 'src'));

const state: any = {
  projectsCache: [
    { id: 'project-start-1', name: 'Start Fixture', repoUrl: 'https://example.com/start', localPath: tempDir },
  ],
};

test('getProjectStartContext returns compact project and top-level file context', () => {
  const result = getProjectStartContext(state, { projectId: 'project-start-1' });

  assert.equal(result.project.id, 'project-start-1');
  assert.equal(result.project.name, 'Start Fixture');
  assert.equal(result.files.count, 3);
  assert.deepEqual(result.hints.present.sort(), ['README.md', 'package.json']);
  assert.ok(result.recommendedNextTools.includes('read_local_file'));
  assert.ok(result.git.available === false || typeof result.git.branch === 'string');
});

test.after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
