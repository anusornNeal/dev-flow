import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from '../src/lib/devFlowPaths';
import { findCrossPlatformViolations } from './crossPlatformPolicy';

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

const sharedRuntimeRoots = ['src/lib', 'src/server'];
const sharedRuntimeFiles: string[] = ['server.ts'];
for (const relativeRoot of sharedRuntimeRoots) {
  const absoluteRoot = path.join(projectRoot, relativeRoot);
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(next);
      } else if (entry.isFile() && /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
        sharedRuntimeFiles.push(path.relative(projectRoot, next).replace(/\\/g, '/'));
      }
    }
  }
}

const crossPlatformViolations = sharedRuntimeFiles.flatMap((relativePath) =>
  findCrossPlatformViolations(relativePath, fs.readFileSync(path.join(projectRoot, relativePath), 'utf8')),
);
assert.deepEqual(
  crossPlatformViolations,
  [],
  `Shared runtime contains cross-platform architecture violations:\n${crossPlatformViolations.map((entry) => `${entry.filePath}:${entry.line} ${entry.code} ${entry.preview}`).join('\n')}`,
);

console.log('[verify-absolute-paths] all assertions passed');
