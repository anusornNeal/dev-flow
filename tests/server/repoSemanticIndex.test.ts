import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-semantic-index-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
fs.writeFileSync(path.join(tempDir, 'src', 'Service.ts'), 'export class Service { run() { return 1; } }\n', 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'Consumer.ts'), "import { Service } from './Service';\nexport function consume(service: Service) { return service.run(); }\n", 'utf8');
fs.writeFileSync(path.join(tempDir, 'src', 'Service.test.ts'), "import { Service } from './Service';\nconst subject = new Service();\n", 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}
git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const state: any = { projectsCache: [{ id: 'project-semantic', name: 'Semantic', repoUrl: 'https://example.com/semantic', localPath: tempDir }] };
const { clearRepoInspectionIndexCache, getRepoSemanticIndex } = await import('../../src/server/services/repoInspectionIndexService.js');

test('semantic index finds definitions, references, imports and related tests from the existing repo index', () => {
  clearRepoInspectionIndexCache();
  const result = getRepoSemanticIndex(state, { projectId: 'project-semantic', symbol: 'Service' });

  assert.deepEqual(result.definitions.map((entry: any) => entry.path), ['src/Service.ts']);
  assert.ok(result.references.some((entry: any) => entry.path === 'src/Consumer.ts'));
  assert.ok(result.references.some((entry: any) => entry.path === 'src/Service.test.ts'));
  assert.ok(result.relatedTests.some((entry: any) => entry.path === 'src/Service.test.ts'));
  assert.ok(result.references.some((entry: any) => entry.imports.includes('./Service')));
});

test.after(() => {
  clearRepoInspectionIndexCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});
