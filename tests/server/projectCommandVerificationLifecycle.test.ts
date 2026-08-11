import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-green-join-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { applyAndVerifyAsync } = await import('../../src/server/services/applyAndVerifyService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function fixture() {
  const root = path.join(tempRoot, 'repo');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'scripts', 'green-a.mjs'), "await new Promise((r) => setTimeout(r, 800)); process.stdout.write('a passed\\n');\n");
  fs.writeFileSync(path.join(root, 'scripts', 'green-b.mjs'), "await new Promise((r) => setTimeout(r, 800)); process.stderr.write('b failed\\n'); process.exit(2);\n");
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), [
    'commands:',
    '  green-a:',
    '    executable: node',
    '    args:',
    '      - scripts/green-a.mjs',
    '    category: test',
    '  green-b:',
    '    executable: node',
    '    args:',
    '      - scripts/green-b.mjs',
    '    category: test',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module' }, null, 2));
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  createProject({ id: 'project-green-join', name: 'Green Join', repoUrl: 'https://example.com/green-join', localPath: root });
  return root;
}

function stateFor(root: string): any {
  return { projectsCache: [{ id: 'project-green-join', name: 'Green Join', repoUrl: 'https://example.com/green-join', localPath: root }] };
}

test('parallel GREEN joins every launched check against one frozen candidate before reporting failure', async () => {
  const root = fixture();
  const result: any = await applyAndVerifyAsync(stateFor(root), {
    projectId: 'project-green-join',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 2' }] }],
    requestedCommands: ['green-a', 'green-b'],
    cacheVerificationResults: false,
    forceFresh: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'verification_failed');
  assert.equal(result.parallelVerification, true);
  assert.equal(result.verification.length, 2, 'all checks launched in the parallel stage must reach terminal state before join');
  assert.equal(result.verificationBatch?.canComplete, false);
  assert.equal(result.verificationBatch?.pending.length, 0);
  assert.equal(result.verificationBatch?.passed.length, 1);
  assert.equal(result.verificationBatch?.failed.length, 1);
  assert.equal(result.verificationBatch?.stale.length, 0);
  assert.equal(result.verificationBatch?.requiredChecks.length, 2);
  assert.equal(
    new Set(result.verification.map((entry: any) => entry.verificationCandidate?.candidateId)).size,
    1,
    'every GREEN command must run against one frozen candidate',
  );
  const summedMs = result.verification.reduce((sum: number, entry: any) => sum + Number(entry.durationMs || 0), 0);
  assert.equal(Number(result.verificationPerformance?.wallMs || 0) < summedMs * 0.8, true, 'independent checks should fan out materially faster than serial sum');
});

after(() => {
  try { db.close(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});
