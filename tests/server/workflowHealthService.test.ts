import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-health-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-health-db-${path.basename(tempRoot)}.sqlite`);
process.env.DEVFLOW_JOBS_DIR = path.join(os.tmpdir(), `devflow-health-jobs-${path.basename(tempRoot)}`);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');

const { getWorkflowHealth } = await import('../../src/server/services/workflowHealthService.js');
const {
  createJob,
  updateJobStatus,
  clearRecentJobCache,
  getRecentJobCacheStats,
} = await import('../../src/server/repositories/mcpToolJobRepository.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return result.stdout.trim();
}

function createRepo(name: string) {
  const repo = path.join(tempRoot, name);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['config', 'user.name', 'DevFlow Test']);
  git(repo, ['config', 'user.email', 'devflow@example.com']);
  fs.writeFileSync(path.join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', 'base.txt']);
  git(repo, ['commit', '-m', 'initial']);
  createProject({ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo });
  return repo;
}

function stateFor(repo: string): any {
  return {
    projectsCache: [{ id: 'project-health', name: 'Health Fixture', repoUrl: 'https://example.com/health', localPath: repo }],
  };
}

test('getWorkflowHealth returns ok for a clean repo', () => {
  const repo = createRepo('clean');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'ok');
  assert.equal(result.git.clean, true);
  assert.equal(result.capabilities.keyToolsPresent.get_repo_context_bundle, true);
  assert.equal(result.capabilities.asyncToolCount > 0, true);
});

test('getWorkflowHealth reports fallback search backend when ripgrep is unavailable', () => {
  const repo = createRepo('search-backend');
  const previous = {
    path: process.env.PATH,
    appRoot: process.env.DEVFLOW_APP_ROOT,
    localAppData: process.env.LOCALAPPDATA,
    programFiles: process.env.ProgramFiles,
  };
  process.env.PATH = '';
  process.env.DEVFLOW_APP_ROOT = path.join(repo, 'missing-app-root');
  process.env.LOCALAPPDATA = path.join(repo, 'missing-local-app-data');
  process.env.ProgramFiles = path.join(repo, 'missing-program-files');
  try {
    const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    assert.equal(result.capabilities.search.backend, 'fallback');
    assert.equal(result.capabilities.search.fallbackAvailable, true);
  } finally {
    process.env.PATH = previous.path;
    if (previous.appRoot === undefined) delete process.env.DEVFLOW_APP_ROOT; else process.env.DEVFLOW_APP_ROOT = previous.appRoot;
    if (previous.localAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous.localAppData;
    if (previous.programFiles === undefined) delete process.env.ProgramFiles; else process.env.ProgramFiles = previous.programFiles;
  }
});

test('getWorkflowHealth warns for a dirty repo', () => {
  const repo = createRepo('dirty');
  fs.writeFileSync(path.join(repo, 'dirty.txt'), 'dirty\n');
  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.git.clean, false);
  assert.match(result.recommendations.join('\n'), /Working tree/);
});


test('getWorkflowHealth exposes phase timings without caching project git state', () => {
  const repo = createRepo('phase-freshness');
  const clean = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(typeof clean.performance.totalMs, 'number');
  assert.equal(typeof clean.performance.phases.diagnosticsMs, 'number');
  assert.equal(typeof clean.performance.phases.gitMs, 'number');

  fs.writeFileSync(path.join(repo, 'fresh-dirty.txt'), 'dirty now\n');
  const dirty = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(dirty.git.clean, false);
  assert.match(dirty.recommendations.join('\n'), /Working tree/);
});

test('getWorkflowHealth groups failed tool jobs by tool name', () => {
  const repo = createRepo('failed-tool-jobs');
  createJob('job-health-failed-1', 'run_project_command', { command: 'verify' }, `repo:${repo}`);
  updateJobStatus('job-health-failed-1', {
    status: 'failed',
    failureSummary: 'verify failed: lint error',
  });

  const result = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });

  assert.equal(result.ok, true);
  assert.equal(result.status, 'warning');
  assert.equal(result.diagnostics.failedJobs > 0, true);
  assert.equal(result.diagnostics.failedJobGroups[0].toolName, 'run_project_command');
  assert.equal(result.diagnostics.failedJobGroups[0].count >= 1, true);
  assert.match(result.recommendations.join('\n'), /run_project_command/);
});

test('workflow health reuses the recent-job index while reflecting incremental job status changes', () => {
  const repo = createRepo('recent-job-index');
  clearRecentJobCache();
  for (let index = 0; index < 120; index += 1) {
    const jobId = `job-health-cache-${index}`;
    createJob(jobId, 'read_local_file', { index }, `repo:${repo}`);
    updateJobStatus(jobId, { status: 'succeeded' });
  }

  const cold = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(cold.ok, true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
  for (let index = 0; index < 20; index += 1) getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);

  createJob('job-health-cache-failed', 'run_project_command', { command: 'test' }, `repo:${repo}`);
  updateJobStatus('job-health-cache-failed', { status: 'failed', failureSummary: 'synthetic failure' });
  const refreshed = getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  assert.equal(refreshed.diagnostics.failedJobGroups.some((group: any) => group.toolName === 'run_project_command'), true);
  assert.equal(getRecentJobCacheStats().diskScanCount, 1);
});

test('workflow health warm p95 remains below the 750ms SLO with a populated job history', () => {
  const repo = createRepo('warm-benchmark');
  getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
  const samples: number[] = [];
  for (let index = 0; index < 24; index += 1) {
    const startedAt = performance.now();
    getWorkflowHealth(stateFor(repo), { projectId: 'project-health' });
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  const p50 = samples[Math.ceil(samples.length * 0.5) - 1];
  const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
  console.log(`[health-benchmark] warm samples=${samples.length} p50=${p50.toFixed(1)}ms p95=${p95.toFixed(1)}ms scanCount=${getRecentJobCacheStats().diskScanCount}`);
  assert.equal(p95 <= 750, true, `expected warm p95 <= 750ms, got ${p95.toFixed(1)}ms`);
});
