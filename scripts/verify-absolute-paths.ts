import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from '../src/lib/devFlowPaths';

const projectRoot = process.cwd();

const targetedFiles = [
  'server.ts',
  'src/db/index.ts',
  'src/server/repositories/skillsRepository.ts',
  'src/server/routes/settings.ts',
  'src/server/services/agentLaunchConfig.ts',
  'src/server/services/localFileService.ts',
];

for (const relativePath of targetedFiles) {
  const source = fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
  assert.equal(
    source.includes('process.cwd()'),
    false,
    `${relativePath} must not derive the DevFlow app root from process.cwd().`,
  );
}

const patchPath = path.join(projectRoot, 'server.patch');
assert.equal(fs.existsSync(patchPath), false, 'server.patch must be removed from the repository.');

const originalCwd = process.cwd();
const outsideCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-app-root-'));
process.chdir(outsideCwd);
try {
  assert.equal(getDevFlowAppRoot(), projectRoot);
  assert.equal(resolveFromDevFlowAppRoot('skills'), path.join(projectRoot, 'skills'));
} finally {
  process.chdir(originalCwd);
}

console.log('[verify-absolute-paths] all assertions passed');
