import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-agent-runs-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../src/db/migrations/index.js');
executeAllMigrations();

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
  getAgentRunHistoryPaths,
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
const historyPaths = getAgentRunHistoryPaths(files.runDir);
assert.equal(historyPaths.promptPath, files.promptPath);
assert.equal(historyPaths.logPath, files.logPath);
assert.ok(historyPaths.launchMetadataPath.endsWith(path.join(run.id, 'launch.json')));
assert.ok(historyPaths.outputSummaryPath.endsWith(path.join(run.id, 'summary.txt')));
assert.ok(historyPaths.resultPath.endsWith(path.join(run.id, 'result.json')));
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
  buildAgentLaunchConfig,
  buildCodexLaunchConfig,
  buildLaunchMetadataBlock,
  loadAgentLaunchConfig,
  runAgentLaunchPreflight,
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

const codexMiniLowPlan = resolveAgentLaunchPlan({
  agent: 'Codex',
  model: 'GPT-5.4 Mini',
  effort: 'low',
  executionMode: 'safe',
});
assert.equal(codexMiniLowPlan.ok, true);
assert.equal(codexMiniLowPlan.resolvedModel, 'gpt-5.4-mini');
assert.equal(codexMiniLowPlan.selectedEffort, 'low');
assert.equal(codexMiniLowPlan.effortHandling.mode, 'cli-flag');

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

const fixtureAppRoot = path.join(tempDir, 'fixture-app');
const fixtureProjectDir = path.join(fixtureAppRoot, 'project');
const fixtureScriptsDir = path.join(fixtureAppRoot, 'scripts');
const fixtureConfigDir = path.join(fixtureAppRoot, 'config', 'agents');
const fixtureExecutablePath = path.join(fixtureAppRoot, 'tools', 'fixture-agent.cmd');
fs.mkdirSync(fixtureProjectDir, { recursive: true });
fs.mkdirSync(fixtureScriptsDir, { recursive: true });
fs.mkdirSync(fixtureConfigDir, { recursive: true });
fs.mkdirSync(path.dirname(fixtureExecutablePath), { recursive: true });
fs.writeFileSync(path.join(fixtureScriptsDir, 'trigger-agent.bat'), '@echo off\r\n', 'utf8');
fs.writeFileSync(path.join(fixtureScriptsDir, 'invoke-agent-trigger.ps1'), 'exit 0\r\n', 'utf8');
fs.writeFileSync(fixtureExecutablePath, '@echo off\r\n', 'utf8');
fs.writeFileSync(path.join(fixtureConfigDir, 'fixtureagent.json'), JSON.stringify({
  name: 'FixtureAgent',
  executables: [{ type: 'path', value: fixtureExecutablePath }],
  flags: {
    model: '--model',
    workingDir: '--cwd',
    effort: '--effort',
  },
  modelMap: {
    'Fixture Model': 'fixture-model',
  },
  launchStyle: 'start',
}, null, 2), 'utf8');

const successfulPreflight = runAgentLaunchPreflight({
  agent: 'FixtureAgent',
  localPath: fixtureProjectDir,
  model: 'Fixture Model',
  effort: 'high',
  executionMode: 'safe',
  appRoot: fixtureAppRoot,
});
assert.equal(successfulPreflight.ok, true);
assert.equal(successfulPreflight.code, 'OK');
assert.equal(successfulPreflight.launchPlan?.resolvedModel, 'fixture-model');

const missingProjectPathPreflight = runAgentLaunchPreflight({
  agent: 'FixtureAgent',
  localPath: path.join(fixtureAppRoot, 'missing-project'),
  model: 'Fixture Model',
  effort: 'high',
  executionMode: 'safe',
  appRoot: fixtureAppRoot,
});
assert.equal(missingProjectPathPreflight.ok, false);
assert.equal(missingProjectPathPreflight.code, 'PROJECT_PATH_NOT_FOUND');
assert.match(missingProjectPathPreflight.message, /Project localPath does not exist/);

const missingTriggerScriptPath = path.join(fixtureScriptsDir, 'trigger-agent.bat');
fs.unlinkSync(missingTriggerScriptPath);
const missingTriggerScriptPreflight = runAgentLaunchPreflight({
  agent: 'FixtureAgent',
  localPath: fixtureProjectDir,
  model: 'Fixture Model',
  effort: 'high',
  executionMode: 'safe',
  appRoot: fixtureAppRoot,
});
assert.equal(missingTriggerScriptPreflight.ok, false);
assert.equal(missingTriggerScriptPreflight.code, 'TRIGGER_SCRIPT_MISSING');
assert.match(missingTriggerScriptPreflight.message, /trigger script/i);
fs.writeFileSync(missingTriggerScriptPath, '@echo off\r\n', 'utf8');

fs.unlinkSync(fixtureExecutablePath);
const missingExecutablePreflight = runAgentLaunchPreflight({
  agent: 'FixtureAgent',
  localPath: fixtureProjectDir,
  model: 'Fixture Model',
  effort: 'high',
  executionMode: 'safe',
  appRoot: fixtureAppRoot,
});
assert.equal(missingExecutablePreflight.ok, false);
assert.equal(missingExecutablePreflight.code, 'EXECUTABLE_NOT_FOUND');
assert.match(missingExecutablePreflight.message, /executable/i);
fs.writeFileSync(fixtureExecutablePath, '@echo off\r\n', 'utf8');

const fakeRunnerScriptPath = path.resolve('scripts', 'fake-codex-runner.cmd');
const fakeRunnerPromptReference = buildPromptReference(files.promptPath);
const fakeRunnerSuccess = spawnSync('cmd.exe', ['/d', '/s', '/c', fakeRunnerScriptPath, fakeRunnerPromptReference], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DEVFLOW_FAKE_CODEX_MODE: 'success',
  },
  encoding: 'utf8',
});
assert.equal(fakeRunnerSuccess.status, 0);
assert.match(fakeRunnerSuccess.stdout, /FAKE_CODEX_RESULT success/);
assert.match(fakeRunnerSuccess.stdout, /full prompt body that should stay off the command line/);

const fakeRunnerFailure = spawnSync('cmd.exe', ['/d', '/s', '/c', fakeRunnerScriptPath, fakeRunnerPromptReference], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    DEVFLOW_FAKE_CODEX_MODE: 'error',
    DEVFLOW_FAKE_CODEX_EXIT_CODE: '7',
  },
  encoding: 'utf8',
});
assert.equal(fakeRunnerFailure.status, 7);
assert.match(fakeRunnerFailure.stderr, /FAKE_CODEX_RESULT error/);

process.env.DEVFLOW_CODEX_EXE = fakeRunnerScriptPath;
const codexConfig = loadAgentLaunchConfig('Codex');
assert.ok(codexConfig);
const fakeRunnerPreflight = runAgentLaunchPreflight({
  agent: 'Codex',
  localPath: fixtureProjectDir,
  model: 'GPT-5.5',
  effort: 'high',
  executionMode: 'safe',
  appRoot: process.cwd(),
});
assert.equal(fakeRunnerPreflight.ok, true);
assert.equal(fakeRunnerPreflight.executablePath, fakeRunnerScriptPath);

const codexLaunchConfig = buildCodexLaunchConfig({
  task: {
    id: 'task-codex-launch',
    agent: 'Codex',
    model: 'GPT-5.5',
    effort: 'high',
  },
  project: {
    localPath: fixtureProjectDir,
  },
  promptPath: files.promptPath,
  runId: 'run-codex-launch',
  executionMode: 'safe',
  apiBaseUrl: 'http://localhost:3000',
  appRoot: process.cwd(),
});
assert.equal(codexLaunchConfig.ok, true);
assert.equal(codexLaunchConfig.cwd, fixtureProjectDir);
assert.equal(codexLaunchConfig.executable, fakeRunnerScriptPath);
assert.deepEqual(codexLaunchConfig.parameters, [
  '-C', fixtureProjectDir,
  '-m', 'gpt-5.5',
  '--config', 'model_reasoning_effort=high',
  '-s', 'workspace-write',
  buildPromptReference(files.promptPath),
]);
assert.equal(codexLaunchConfig.environment.DEVFLOW_AGENT_EXECUTION_MODE, 'safe');
assert.equal(codexLaunchConfig.environment.DEVFLOW_API_BASE_URL, 'http://localhost:3000');
assert.match(codexLaunchConfig.previewText, /gpt-5\.5/);
assert.match(codexLaunchConfig.previewText, /model_reasoning_effort=high/);
assert.match(codexLaunchConfig.previewText, new RegExp(files.promptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

process.env.DEVFLOW_AGY_EXE = fakeRunnerScriptPath;
const antigravityLaunchConfig = buildAgentLaunchConfig({
  task: {
    id: 'task-antigravity-launch',
    agent: 'Antigravity',
    model: 'Gemini 3.5 Flash',
    effort: 'high',
  },
  project: {
    localPath: fixtureProjectDir,
  },
  promptPath: files.promptPath,
  logPath: files.logPath,
  runId: 'run-antigravity-launch',
  executionMode: 'safe',
  apiBaseUrl: 'http://localhost:3000',
  appRoot: process.cwd(),
});
assert.equal(antigravityLaunchConfig.ok, true);
assert.equal(antigravityLaunchConfig.executable, fakeRunnerScriptPath);
assert.deepEqual(antigravityLaunchConfig.parameters, [
  '--model', 'gemini-3.5-flash',
  '-i',
  buildPromptReference(files.promptPath),
]);
assert.equal(antigravityLaunchConfig.cwd, fixtureProjectDir);
assert.equal(antigravityLaunchConfig.environment.DEVFLOW_AGENT_EXECUTION_MODE, 'safe');
assert.equal(antigravityLaunchConfig.environment.DEVFLOW_API_BASE_URL, 'http://localhost:3000');
assert.match(antigravityLaunchConfig.previewText, /Antigravity launch preview: run=run-antigravity-launch/);
assert.match(antigravityLaunchConfig.previewText, new RegExp(`executable=${fakeRunnerScriptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
assert.match(antigravityLaunchConfig.previewText, /resolvedModel=gemini-3\.5-flash/);
assert.match(antigravityLaunchConfig.previewText, /selectedEffort=high/);
assert.match(antigravityLaunchConfig.previewText, /effortHandling=prompt-only/);
assert.match(antigravityLaunchConfig.previewText, /executionMode=safe/);
assert.match(antigravityLaunchConfig.previewText, new RegExp(`promptPath=${files.promptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
assert.match(antigravityLaunchConfig.previewText, new RegExp(`logPath=${files.logPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

const codexLaunchPreview = buildCodexLaunchConfig({
  task: {
    id: 'task-codex-preview',
    agent: 'Codex',
    model: 'GPT-5.4 Mini',
    effort: 'low',
  },
  project: {
    localPath: fixtureProjectDir,
  },
  promptPath: files.promptPath,
  runId: 'preview-run',
  executionMode: 'full',
  apiBaseUrl: 'http://localhost:3000',
  appRoot: process.cwd(),
  preview: true,
});
assert.equal(codexLaunchPreview.ok, true);
assert.deepEqual(codexLaunchPreview.parameters, [
  '-C', fixtureProjectDir,
  '-m', 'gpt-5.4-mini',
  '--config', 'model_reasoning_effort=low',
  '--dangerously-bypass-approvals-and-sandbox',
  '-s', 'danger-full-access',
  buildPromptReference(files.promptPath),
]);
assert.match(codexLaunchPreview.previewText, /run=preview-run/);
delete process.env.DEVFLOW_CODEX_EXE;
delete process.env.DEVFLOW_AGY_EXE;

const {
  buildAgentCliArgs,
  buildLauncherDispatch,
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
      effort: ['--config', 'model_reasoning_effort='],
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
  '--config', 'model_reasoning_effort=high',
  '-s', 'workspace-write',
  buildPromptReference(files.promptPath),
]);
assert.equal(cliArgs.includes('--config model_reasoning_effort=high'), false);
assert.equal(cliArgs.includes('full prompt body that should stay off the command line'), false);
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'GPT-5.5'), 'gpt-5.5');
assert.equal(mapModelForAgent({ modelMap: { 'GPT-5.5': 'gpt-5.5' } }, 'Unknown'), '');

const miniLowArgs = buildAgentCliArgs({
  config: {
    name: 'Codex',
    executables: [],
    flags: {
      model: '-m',
      workingDir: '-C',
      effort: ['--config', 'model_reasoning_effort='],
    },
    modelMap: {
      'GPT-5.4 Mini': 'gpt-5.4-mini',
    },
    launchStyle: 'start',
  },
  localPath: fixtureRepoPath,
  model: 'GPT-5.4 Mini',
  effort: 'low',
  promptReference: 'prompt',
  executionMode: 'safe',
});
assert.deepEqual(miniLowArgs, [
  '-C', fixtureRepoPath,
  '-m', 'gpt-5.4-mini',
  '--config', 'model_reasoning_effort=low',
  'prompt',
]);
assert.equal(miniLowArgs.includes('model_reasoning_effort=high'), false);

for (const effort of ['low', 'medium', 'high', 'xhigh']) {
  const effortArgs = buildAgentCliArgs({
    config: {
      name: 'Codex',
      executables: [],
      flags: {
        model: null,
        effort: ['--config', 'model_reasoning_effort='],
      },
      launchStyle: 'start',
    },
    localPath: '',
    model: '',
    effort,
    promptReference: 'prompt',
    executionMode: 'safe',
  });
  assert.deepEqual(effortArgs, ['--config', `model_reasoning_effort=${effort}`, 'prompt']);
  assert.equal(effortArgs.includes(`--config model_reasoning_effort=${effort}`), false);
}

const noEffortArgs = buildAgentCliArgs({
  config: {
    name: 'Codex',
    executables: [],
    flags: {
      model: '-m',
      effort: ['--config', 'model_reasoning_effort='],
    },
    modelMap: {
      'GPT-5.5': 'gpt-5.5',
    },
    launchStyle: 'start',
  },
  localPath: '',
  model: 'GPT-5.5',
  effort: '',
  promptReference: 'prompt',
  executionMode: 'safe',
});
assert.deepEqual(noEffortArgs, ['-m', 'gpt-5.5', 'prompt']);

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
  args: ['-C', fixtureWorkDir, '-m', 'gpt-5.5', '--config', 'model_reasoning_effort=high', buildPromptReference(files.promptPath)],
  cwd: fixtureWorkDir,
  windowTitle: 'Codex Agent',
  logPath: files.logPath,
});
const launchScript = fs.readFileSync(launchScriptPath, 'utf8');
assert.match(launchScript, /title Codex Agent/);
assert.ok(launchScript.includes(`cd /d "${fixtureWorkDir}"`));
assert.ok(launchScript.includes(`call "${fixtureCodexPath}"`));
assert.ok(launchScript.includes(`"${fixtureCodexPath}" "-C" "${fixtureWorkDir}" "-m" "gpt-5.5" "--config" "model_reasoning_effort=high"`));
assert.equal(launchScript.includes('"--config model_reasoning_effort=high"'), false);
assert.equal(launchScript.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), false);
assert.match(launchScript, /exitCode/);
assert.match(launchScript, /errorMessage/);
assert.match(launchScript, /Codex process exited with code/);
assert.match(launchScript, /completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%/);
assert.match(launchScript, /pause/);

const launcherDispatch = buildLauncherDispatch({
  cwd: fixtureWorkDir,
  launchScriptPath,
});
assert.equal(launcherDispatch.command, 'powershell.exe');
assert.ok(launcherDispatch.args.includes('Start-Process'));
assert.ok(launcherDispatch.args.includes(launchScriptPath));
assert.ok(launcherDispatch.args.includes(fixtureWorkDir));
assert.equal(launcherDispatch.args.includes('start'), false);

const miniLowLaunchScriptPath = createCodexLaunchScript({
  runId: 'run-script-test-low',
  taskId: 'task-script-test-low',
  apiBaseUrl: 'http://localhost:3000',
  runDir: files.runDir,
  executable: fixtureCodexPath,
  args: ['-C', fixtureWorkDir, '-m', 'gpt-5.4-mini', '--config', 'model_reasoning_effort=low', 'prompt'],
  cwd: fixtureWorkDir,
  windowTitle: 'Codex Agent',
  logPath: files.logPath,
});
const miniLowLaunchScript = fs.readFileSync(miniLowLaunchScriptPath, 'utf8');
assert.ok(miniLowLaunchScript.includes(`"${fixtureCodexPath}" "-C" "${fixtureWorkDir}" "-m" "gpt-5.4-mini" "--config" "model_reasoning_effort=low"`));
assert.equal(miniLowLaunchScript.includes('model_reasoning_effort=high'), false);

const {
  validateAgentParams,
} = await import('../src/server/services/taskService');

// Codex combinations
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.5', effort: 'low' }, []), null);
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.5', effort: 'medium' }, []), null);
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.5', effort: 'high' }, []), null);
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.5', effort: 'xhigh' }, []), null);
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4', effort: 'xhigh' }, []), null);
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4 Mini', effort: 'xhigh' }, []), null);
assert.match(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4', effort: 'none' }, []) || '', /Invalid effort 'none' for model 'GPT-5.4'/);
assert.match(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4', effort: 'minimal' }, []) || '', /Invalid effort 'minimal' for model 'GPT-5.4'/);
assert.match(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4', effort: 'max' }, []) || '', /Invalid effort 'max' for model 'GPT-5.4'/);

// Antigravity combinations
assert.match(validateAgentParams({ agent: 'Antigravity', model: 'GPT-5.5', effort: 'high' }, []) || '', /not supported by Antigravity/);
assert.equal(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.5 Flash', effort: 'low' }, []), null);
assert.equal(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.5 Flash', effort: 'medium' }, []), null);
assert.equal(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.5 Flash', effort: 'high' }, []), null);
assert.match(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.5 Flash', effort: 'minimal' }, []) || '', /Invalid effort 'minimal' for model 'Gemini 3.5 Flash'/);

assert.equal(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'low' }, []), null);
assert.equal(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'high' }, []), null);
assert.match(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'medium' }, []) || '', /Invalid effort 'medium' for model 'Gemini 3.1 Pro'/);
assert.match(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'minimal' }, []) || '', /Invalid effort 'minimal' for model 'Gemini 3.1 Pro'/);
assert.match(validateAgentParams({ agent: 'Antigravity', model: 'Gemini 3.1 Pro', effort: 'xhigh' }, []) || '', /Invalid effort 'xhigh' for model 'Gemini 3.1 Pro'/);

// Claude combinations
assert.equal(validateAgentParams({ agent: 'Claude', model: 'Claude 4.8 Opus', effort: 'xhigh' }, []), null);
assert.match(validateAgentParams({ agent: 'Claude', model: 'Claude 4.8 Opus', effort: 'minimal' }, []) || '', /Invalid effort 'minimal' for model 'Claude 4.8 Opus'/);

// Legacy safety test: tasks loading and prompt rendering must not crash
assert.equal(validateAgentParams({ agent: 'Codex', model: 'GPT-5.4', effort: 'legacy-unknown' }, []), "Invalid effort: legacy-unknown. Must be one of: none, minimal, low, medium, high, xhigh, max");

const { renderTaskPrompt } = await import('../src/server/services/taskService');
const mockTask = {
  id: 'legacy-task-1',
  displayId: 'LEGACY-1',
  title: 'Legacy task',
  projectId: 'proj-1',
  status: 'todo',
  priority: 'low',
  agent: 'Codex',
  model: 'GPT-5.4',
  effort: 'legacy-unknown',
};

const mockState = {
  projects: [{
    id: 'proj-1',
    name: 'Project 1',
    localPath: tempDir,
    repoUrl: 'foo',
    branch: 'main',
  }],
  projectsCache: [{
    id: 'proj-1',
    name: 'Project 1',
    localPath: tempDir,
    repoUrl: 'foo',
    branch: 'main',
  }],
  _testTasks: [mockTask],
  tasks: [mockTask],
  workspaceConfig: { localPath: tempDir },
};

// Must not throw when building prompt for task with unsupported effort
try {
  const { saveTask } = await import('../src/server/repositories/taskRepository.js');
  saveTask(mockTask);
  const result = renderTaskPrompt(mockState as any, 'legacy-task-1');
  assert.equal(result.context.assignment.effort, 'legacy-unknown');
  assert.ok(result.renderResult.content.length > 0);
} catch (e: any) {
  assert.fail(`Prompt rendering crashed for legacy task: ${e.message}`);
}

const spaceRunDir = path.join(tempDir, 'run with spaces');
const spaceCwd = path.join(tempDir, 'repo with spaces');
const spacePromptPath = path.join(tempDir, 'prompt with spaces.md');
const spaceLogPath = path.join(tempDir, 'log with spaces.log');
const spaceExecutable = path.join(tempDir, 'agent with spaces.exe');

const antigravityLaunchScriptPath = createAgentLaunchScript({
  runId: 'run-space-test',
  taskId: 'task-space-test',
  apiBaseUrl: 'http://localhost:3000',
  runDir: spaceRunDir,
  executable: spaceExecutable,
  args: ['--model', 'gemini-3.5-flash', '-i', buildPromptReference(spacePromptPath)],
  cwd: spaceCwd,
  windowTitle: 'Antigravity Agent',
  logPath: spaceLogPath,
});

const antigravityLaunchScript = fs.readFileSync(antigravityLaunchScriptPath, 'utf8');
assert.ok(antigravityLaunchScript.includes(`cd /d "${spaceCwd}"`));
assert.ok(antigravityLaunchScript.includes(`"${spaceExecutable}" "--model" "gemini-3.5-flash" "-i" "${buildPromptReference(spacePromptPath)}"`));
assert.ok(antigravityLaunchScript.includes(`>> "${spaceLogPath}"`));
assert.equal(antigravityLaunchScript.includes('start "'), false);
assert.equal(antigravityLaunchScript.includes('cmd.exe /c start'), false);
assert.equal(antigravityLaunchScript.includes('cmd.exe /s /c start'), false);

console.log('[verify-agent-runs] all assertions passed');
