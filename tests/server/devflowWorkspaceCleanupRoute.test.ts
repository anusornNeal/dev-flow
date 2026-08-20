import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-cleanup-route-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, '.devflow');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { registerDevFlowRoutes } = await import('../../src/server/routes/devflow.js');
const {
  cleanupSessionWorkspace,
  createOrReuseSessionWorkspace,
  resetSessionWorkspaceRuntimeForTests,
} = await import('../../src/server/services/sessionWorkspaceService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-workspace-cleanup-route-repo-'));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'README.md'), 'base\n');
  git(root, ['add', 'README.md']);
  git(root, ['commit', '-m', 'base']);
  return root;
}

async function withServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerDevFlowRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
    restartProcess: () => {},
  } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind workspace cleanup route test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test('normal workspace cleanup route cannot request force semantics', async () => {
  resetSessionWorkspaceRuntimeForTests();
  const repo = createRepo();
  const workspace = createOrReuseSessionWorkspace({ id: 'project-route-cleanup', localPath: repo } as any, 'route-cleanup-chat');

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/workspaces/cleanup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: workspace.workspaceId, force: true }),
    });
    const body = await response.json() as any;
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.error?.code, 'WORKSPACE_CLEANUP_FORCE_UNSUPPORTED');
  });

  assert.equal(fs.existsSync(workspace.root), true);
  assert.equal(cleanupSessionWorkspace(workspace.workspaceId).removed, true);
});
