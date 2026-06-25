import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-health-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { getWorkflowHealth } = await import('../../src/server/services/workflowHealthService.js');
const { createJob, updateJobStatus } = await import('../../src/server/repositories/mcpToolJobRepository.js');

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
