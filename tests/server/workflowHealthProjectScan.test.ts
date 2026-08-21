import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-health-scan-'));
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'health-scan.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');

const runtimeSourceRoot = path.join(tempRoot, 'runtime-source');
fs.mkdirSync(runtimeSourceRoot, { recursive: true });
git(runtimeSourceRoot, ['init']);
git(runtimeSourceRoot, ['config', 'user.name', 'DevFlow Test']);
git(runtimeSourceRoot, ['config', 'user.email', 'devflow@example.com']);
fs.writeFileSync(path.join(runtimeSourceRoot, 'runtime-source.txt'), 'runtime source v1\n');
git(runtimeSourceRoot, ['add', '.']);
git(runtimeSourceRoot, ['commit', '-m', 'runtime source v1']);
git(runtimeSourceRoot, ['branch', '-M', 'develop']);
process.env.DEVFLOW_RUNTIME_SOURCE_ROOT = runtimeSourceRoot;

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { saveTask } = await import('../../src/server/repositories/taskRepository.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { createExecutionSessionRecord } = await import('../../src/server/repositories/executionSessionRepository.js');
const { getChatGptHarnessHealthSnapshot } = await import('../../src/server/services/workflowHealthService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function createRepo() {
  const repo = path.join(tempRoot, 'project');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  git(repo, ['branch', '-M', 'develop']);
  createProject({ id: 'project-health-scan', name: 'Health Scan Fixture', repoUrl: 'https://example.com/health-scan', localPath: repo });
  return repo;
}

function seedTask(index: number) {
  const now = new Date().toISOString();
  saveTask({
    id: `task-health-scan-${index}`,
    displayId: `DVF-HEALTH-SCAN-${index}`,
    title: 'Health scan fixture',
    description: 'Exercise bounded project lifecycle aggregation.',
    projectId: 'project-health-scan',
    status: 'todo',
    priority: 'high',
    category: 'backend',
    tags: [],
    targetFiles: ['base.txt'],
    checklist: [],
    logs: [],
    bugs: [],
    images: [],
    createdAt: now,
    updatedAt: now,
  } as any);
}

test('project health completes bounded lifecycle scans while preserving complete aggregate counts', () => {
  const repo = createRepo();
  const baseRevision = git(repo, ['rev-parse', 'HEAD']);
  for (let index = 0; index < 105; index += 1) seedTask(index);
  const executionNow = new Date();
  for (let index = 0; index < 55; index += 1) {
    createExecutionSessionRecord({
      id: `exec-health-scan-${index}`,
      projectId: 'project-health-scan',
      taskId: `task-health-scan-${index}`,
      workspaceId: `ws-health-execution-${index}`,
      branch: `devflow/ws/health-scan-${index}`,
      baseRevision,
      repoRevision: baseRevision,
      status: 'active',
      contextHandle: null,
      createdAt: executionNow.toISOString(),
      updatedAt: executionNow.toISOString(),
      expiresAt: new Date(executionNow.getTime() + 60_000).toISOString(),
      endedAt: null,
    });
  }

  const registryDir = path.join(process.env.DEVFLOW_RUNTIME_DIR!, 'workspaces', 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    const workspaceId = `ws-health-scan-${String(index).padStart(2, '0')}`;
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(registryDir, `${workspaceId}.json`), JSON.stringify({
      workspaceId,
      sessionIdHash: `health-scan-${index}`,
      projectId: 'project-health-scan',
      projectRoot: repo,
      root: repo,
      branch: 'develop',
      baseBranch: 'develop',
      baseRevision,
      state: 'ready',
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
  }

  for (let index = 0; index < 25; index += 1) {
    const workspaceId = `ws-health-actionable-${String(index).padStart(2, '0')}`;
    const now = new Date().toISOString();
    fs.writeFileSync(path.join(registryDir, `${workspaceId}.json`), JSON.stringify({
      workspaceId,
      sessionIdHash: `health-actionable-${index}`,
      projectId: 'project-health-scan',
      projectRoot: repo,
      root: path.join(tempRoot, 'missing-workspaces', workspaceId),
      branch: `health-actionable-${index}`,
      baseBranch: 'develop',
      baseRevision,
      state: 'ready',
      createdAt: now,
      lastUsedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }));
  }

  const health: any = getChatGptHarnessHealthSnapshot({
    projectsCache: [{ id: 'project-health-scan', name: 'Health Scan Fixture', repoUrl: 'https://example.com/health-scan', localPath: repo }],
  } as any, { projectId: 'project-health-scan' });

  assert.equal(health.aggregate.activeExecutionCount, 55);
  assert.equal(health.aggregate.activeClaimCount, 0);
  assert.equal(health.drift.some((entry: any) => entry.code === 'ACTIVE_EXECUTION_WITHOUT_ACTIVE_CLAIM'), true);
  assert.equal(health.aggregate.actionableWorkspaceCount, 25);
  assert.equal(health.aggregate.truncated, false);
  assert.equal(health.drift.some((entry: any) => entry.code === 'PROJECT_LIFECYCLE_SCAN_TRUNCATED'), false);
});
