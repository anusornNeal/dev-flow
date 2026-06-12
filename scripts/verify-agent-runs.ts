import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-agent-runs-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const {
  ACTIVE_AGENT_RUN_STATUSES,
  cancelActiveRunsForTask,
  createAgentRun,
  getActiveRunForProject,
  getLatestAgentRunForTask,
  listAgentRunsForTask,
  updateAgentRunStatus,
} = await import('../src/server/repositories/agentRunRepository');

assert.deepEqual(ACTIVE_AGENT_RUN_STATUSES, ['queued', 'starting', 'running']);

const run = createAgentRun({
  taskId: 'task-1',
  projectId: 'project-1',
  agent: 'Codex',
  model: 'GPT-5.5',
  effort: 'high',
  promptPath: path.join(tempDir, 'runs', 'run-1', 'prompt.md'),
  logPath: path.join(tempDir, 'runs', 'run-1', 'agent.log'),
  triggerSource: 'verify-script',
});

assert.equal(run.status, 'queued');
assert.ok(run.id.startsWith('run-'));
assert.equal(getActiveRunForProject('project-1')?.id, run.id);

const running = updateAgentRunStatus(run.id, 'running', { startedAt: '2026-06-12T00:00:00.000Z' });
assert.equal(running?.status, 'running');
assert.equal(running?.startedAt, '2026-06-12T00:00:00.000Z');

const cancelledCount = cancelActiveRunsForTask('task-1', 'manual cancel');
assert.equal(cancelledCount, 1);
assert.equal(getActiveRunForProject('project-1'), null);

const latest = getLatestAgentRunForTask('task-1');
assert.equal(latest?.status, 'cancelled');
assert.equal(latest?.errorMessage, 'manual cancel');
assert.equal(listAgentRunsForTask('task-1').length, 1);

const {
  buildPromptReference,
  createAgentRunFiles,
  getAgentTriggerScriptPath,
  resolveAgentExecutionMode,
} = await import('../src/server/services/agentRunService');

const files = createAgentRunFiles({
  runId: run.id,
  prompt: 'full prompt body that should stay off the command line',
  baseDir: tempDir,
});

assert.equal(fs.readFileSync(files.promptPath, 'utf8'), 'full prompt body that should stay off the command line');
assert.ok(files.logPath.endsWith(path.join(run.id, 'agent.log')));
assert.equal(buildPromptReference(files.promptPath), `Read and follow the DevFlow prompt file at: ${files.promptPath}`);
assert.equal(resolveAgentExecutionMode(undefined), 'safe');
assert.equal(resolveAgentExecutionMode('full'), 'full');
assert.equal(resolveAgentExecutionMode('unexpected'), 'safe');
assert.equal(getAgentTriggerScriptPath(tempDir), path.join(tempDir, 'scripts', 'trigger-agent.bat'));

const successfulRun = createAgentRun({
  taskId: 'task-success',
  projectId: 'project-success',
  agent: 'Codex',
});
assert.equal(updateAgentRunStatus(successfulRun.id, 'succeeded')?.status, 'succeeded');

const spawnFailedRun = createAgentRun({
  taskId: 'task-spawn-fail',
  projectId: 'project-spawn-fail',
  agent: 'Codex',
});
const failed = updateAgentRunStatus(spawnFailedRun.id, 'failed', { errorMessage: 'spawn failed' });
assert.equal(failed?.status, 'failed');
assert.equal(failed?.errorMessage, 'spawn failed');

const retryRun = createAgentRun({
  taskId: 'task-spawn-fail',
  projectId: 'project-spawn-fail',
  agent: 'Codex',
  retryOfRunId: spawnFailedRun.id,
});
assert.equal(retryRun.retryOfRunId, spawnFailedRun.id);

const busyRun = createAgentRun({
  taskId: 'task-busy',
  projectId: 'project-busy',
  agent: 'Codex',
});
assert.equal(getActiveRunForProject('project-busy')?.id, busyRun.id);

const {
  buildAgentCliArgs,
  mapModelForAgent,
} = await import('../src/runner');

const cliArgs = buildAgentCliArgs({
  config: {
    name: 'Codex',
    executables: [],
    flags: {
      model: '-m',
      workingDir: '-C',
      alwaysAllow: '--dangerously-bypass-approvals-and-sandbox',
      interactiveArgs: ['-a', 'never'],
    },
    executionModes: {
      safe: { args: ['-s', 'workspace-write'] },
      full: { args: ['-s', 'danger-full-access'] },
    },
    modelMap: {
      'GPT-5.5': 'gpt-5.5',
    },
    launchStyle: 'cmd_k',
  },
  localPath: 'C:\\work',
  model: 'GPT-5.5',
  effort: '',
  promptReference: buildPromptReference(files.promptPath),
  executionMode: 'safe',
});

assert.deepEqual(cliArgs, [
  '-C', 'C:\\work',
  '-m', 'gpt-5.5',
  '-a', 'never',
  '-s', 'workspace-write',
  buildPromptReference(files.promptPath),
]);
assert.equal(cliArgs.includes('full prompt body that should stay off the command line'), false);
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'GPT-5.5'), 'gpt-5.5');
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'Unknown'), 'Unknown');

console.log('[verify-agent-runs] all assertions passed');
