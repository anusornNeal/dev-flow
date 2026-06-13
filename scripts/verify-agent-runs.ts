import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-agent-runs-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const {
  ACTIVE_AGENT_RUN_STATUSES,
  cancelStaleActiveRuns,
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
const fixtureRepoPath = path.win32.join('fixtures', 'repo');
const fixtureWorkDir = path.win32.join('fixtures', 'work dir');
const fixtureCodexPath = path.win32.join('tools', 'codex.cmd');

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

const staleRun = createAgentRun({
  taskId: 'task-stale',
  projectId: 'project-stale',
  agent: 'Codex',
});
updateAgentRunStatus(staleRun.id, 'running', { startedAt: '2026-06-12T00:00:00.000Z' });
assert.equal(cancelStaleActiveRuns('2026-06-12T00:30:00.000Z', 'stale test cleanup'), 1);
assert.equal(getActiveRunForProject('project-stale'), null);
assert.equal(getLatestAgentRunForTask('task-stale')?.status, 'cancelled');

const {
  buildLaunchMetadataBlock,
  resolveAgentLaunchPlan,
} = await import('../src/server/services/agentLaunchConfig');

const codexPlan = resolveAgentLaunchPlan({
  agent: 'Codex',
  model: 'GPT-5.5',
  effort: 'xhigh',
  executionMode: 'safe',
});
assert.equal(codexPlan.resolvedModel, 'gpt-5.5');
assert.equal(codexPlan.effortHandling.mode, 'cli-flag');

const antigravityInvalid = resolveAgentLaunchPlan({
  agent: 'Antigravity',
  model: 'GPT-5.5',
  effort: 'high',
  executionMode: 'safe',
});
assert.equal(antigravityInvalid.ok, false);
assert.match(antigravityInvalid.error || '', /not supported by Antigravity/);

const metadataBlock = buildLaunchMetadataBlock(codexPlan);
assert.match(metadataBlock, /Selected agent: Codex/);
assert.match(metadataBlock, /DevFlow model label: GPT-5\.5/);
assert.match(metadataBlock, /Resolved CLI model id: gpt-5\.5/);
assert.match(metadataBlock, /Selected effort: xhigh/);
assert.match(metadataBlock, /Effort handling mode: cli-flag/);

const {
  buildAgentCliArgs,
  buildWindowsStartCommand,
  createAgentLaunchScript,
  mapModelForAgent,
  normalizeRunnerPaths,
} = await import('../src/runner');

const normalizedRunnerPaths = normalizeRunnerPaths({
  localPath: 'relative-repo',
  promptPath: path.join('relative-runs', 'prompt.md'),
  logPath: path.join('relative-runs', 'agent.log'),
});
assert.equal(normalizedRunnerPaths.localPath, path.resolve('relative-repo'));
assert.equal(normalizedRunnerPaths.promptPath, path.resolve('relative-runs', 'prompt.md'));
assert.equal(normalizedRunnerPaths.logPath, path.resolve('relative-runs', 'agent.log'));

const cliArgs = buildAgentCliArgs({
  config: {
    name: 'Codex',
    executables: [],
    flags: {
      model: '-m',
      workingDir: '-C',
      alwaysAllow: '--dangerously-bypass-approvals-and-sandbox',
      effort: ['--config', 'reasoning_effort='],
    },
    executionModes: {
      safe: { args: ['-s', 'workspace-write'] },
      full: { args: ['-s', 'danger-full-access'] },
    },
    modelMap: {
      'GPT-5.5': 'gpt-5.5',
    },
    launchStyle: 'start',
  },
  localPath: fixtureRepoPath,
  model: 'GPT-5.5',
  effort: 'high',
  promptReference: buildPromptReference(files.promptPath),
  executionMode: 'safe',
});

assert.deepEqual(cliArgs, [
  '-C', fixtureRepoPath,
  '-m', 'gpt-5.5',
  '--config', 'reasoning_effort=high',
  '-s', 'workspace-write',
  buildPromptReference(files.promptPath),
]);
assert.equal(cliArgs.includes('--config reasoning_effort=high'), false);
assert.equal(cliArgs.includes('full prompt body that should stay off the command line'), false);
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'GPT-5.5'), 'gpt-5.5');
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'Unknown'), '');

for (const effort of ['low', 'medium', 'high', 'xhigh']) {
  const effortArgs = buildAgentCliArgs({
    config: {
      name: 'Codex',
      executables: [],
      flags: {
        model: null,
        effort: ['--config', 'reasoning_effort='],
      },
      launchStyle: 'start',
    },
    localPath: '',
    model: '',
    effort,
    promptReference: 'prompt',
    executionMode: 'safe',
  });
  assert.deepEqual(effortArgs, ['--config', `reasoning_effort=${effort}`, 'prompt']);
  assert.equal(effortArgs.includes(`--config reasoning_effort=${effort}`), false);
}

const concatenatedEffortArgs = buildAgentCliArgs({
  config: {
    name: 'ConcatenatedAgent',
    executables: [],
    flags: {
      model: null,
      effort: '--effort=',
    },
    launchStyle: 'start',
  },
  localPath: '',
  model: '',
  effort: 'high',
  promptReference: 'prompt',
  executionMode: 'safe',
});
assert.deepEqual(concatenatedEffortArgs, ['--effort=high', 'prompt']);

const pairedEffortArgs = buildAgentCliArgs({
  config: {
    name: 'PairedAgent',
    executables: [],
    flags: {
      model: null,
      effort: '--effort',
    },
    launchStyle: 'start',
  },
  localPath: '',
  model: '',
  effort: 'high',
  promptReference: 'prompt',
  executionMode: 'safe',
});
assert.deepEqual(pairedEffortArgs, ['--effort', 'high', 'prompt']);

const agyArgs = buildAgentCliArgs({
  config: {
    name: 'Antigravity',
    executables: [],
    flags: {
      model: '--model',
      effort: null,
      interactiveArgs: ['-i'],
    },
    executionModes: {
      safe: { args: [] },
    },
    modelMap: {
      'Gemini 3.1 Pro': 'gemini-3.1-pro',
    },
    promptFallback: {
      effort: "use reasoning effort '{EFFORT}'",
    },
    launchStyle: 'start',
  },
  localPath: fixtureRepoPath,
  model: 'Gemini 3.1 Pro',
  effort: 'high',
  promptReference: buildPromptReference(files.promptPath),
  executionMode: 'safe',
});
assert.deepEqual(agyArgs, [
  '--model', 'gemini-3.1-pro',
  '-i',
  buildPromptReference(files.promptPath),
]);
assert.equal(agyArgs.some((arg) => arg.includes('reasoning effort')), false);

const { createCodexLaunchScript } = await import('../src/runner');

const launchScriptPath = createCodexLaunchScript({
  runId: 'run-script-test',
  taskId: 'task-script-test',
  apiBaseUrl: 'http://localhost:3000',
  runDir: files.runDir,
  executable: fixtureCodexPath,
  args: ['-C', fixtureWorkDir, '-m', 'gpt-5.5', '--config', 'reasoning_effort=high', buildPromptReference(files.promptPath)],
  cwd: fixtureWorkDir,
  windowTitle: 'Codex Agent',
  logPath: files.logPath,
});
const launchScript = fs.readFileSync(launchScriptPath, 'utf8');
assert.match(launchScript, /title Codex Agent/);
assert.ok(launchScript.includes(`cd /d "${fixtureWorkDir}"`));
assert.ok(launchScript.includes(`call "${fixtureCodexPath}"`));
assert.ok(launchScript.includes(`"${fixtureCodexPath}" "-C" "${fixtureWorkDir}" "-m" "gpt-5.5" "--config" "reasoning_effort=high"`));
assert.equal(launchScript.includes('"--config reasoning_effort=high"'), false);
assert.equal(launchScript.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), false);
assert.match(launchScript, /exitCode/);
assert.match(launchScript, /errorMessage/);
assert.match(launchScript, /Codex process exited with code/);
assert.match(launchScript, /completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%/);
assert.match(launchScript, /pause/);

const {
  validateAgentParams,
} = await import('../src/server/services/taskService');

assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.5', effort: 'xhigh' }, []), null);
assert.match(
  validateAgentParams({ agent: 'Antigravity', model: 'GPT-5.5', effort: 'high' }, []) || '',
  /not supported by Antigravity/,
);

console.log('[verify-agent-runs] all assertions passed');
