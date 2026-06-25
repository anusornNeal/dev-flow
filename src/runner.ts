import * as fs from 'fs';
import * as path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { getDevFlowAppRoot } from './lib/devFlowPaths';
import { buildPromptReference, getAgentRunsBaseDir, resolveAgentExecutionMode, type AgentExecutionMode } from './server/services/agentRunService';
import { buildAgentCliArgs as buildSharedAgentCliArgs, buildAgentLaunchConfig, buildLaunchMetadataBlock, mapModelForAgent as mapSharedModelForAgent, resolveAgentLaunchPlan, type FileAgentConfig } from './server/services/agentLaunchConfig';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type AgentConfig = FileAgentConfig;

interface BuildAgentCliArgsInput {
  config: AgentConfig;
  localPath: string;
  model: string;
  effort: string;
  promptReference: string;
  executionMode: AgentExecutionMode;
}

interface RunnerPathsInput {
  localPath: string;
  promptPath: string;
  logPath: string;
}

export const buildAgentCliArgs = buildSharedAgentCliArgs;
export const mapModelForAgent = mapSharedModelForAgent;

function quoteBatArg(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildLaunchCommandLine(executable: string, args: string[]) {
  const quotedExecutable = quoteBatArg(executable);
  const quotedArgs = args.map(quoteBatArg).join(' ');
  const isBatchScript = /\.(cmd|bat)$/i.test(executable);
  return `${isBatchScript ? 'call ' : ''}${quotedExecutable}${quotedArgs ? ` ${quotedArgs}` : ''}`;
}

function buildLoggedLaunchCommandLine(executable: string, args: string[], logPath?: string | null) {
  const commandLine = buildLaunchCommandLine(executable, args);
  if (!logPath) return commandLine;
  return `${commandLine} >> ${quoteBatArg(logPath)} 2>&1`;
}

export function buildLauncherDispatch(input: {
  cwd: string;
  launchScriptPath: string;
}) {
  return {
    command: 'powershell.exe',
    args: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Start-Process',
      '-FilePath',
      input.launchScriptPath,
      '-WorkingDirectory',
      input.cwd,
    ],
  };
}

function appendRunnerLog(logPath: string | null | undefined, message: string) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

export function normalizeRunnerPaths(input: RunnerPathsInput) {
  return {
    localPath: input.localPath ? path.resolve(input.localPath) : '',
    promptPath: input.promptPath ? path.resolve(input.promptPath) : '',
    logPath: input.logPath ? path.resolve(input.logPath) : '',
  };
}

export function createAgentLaunchScript(input: {
  runId: string;
  taskId: string;
  apiBaseUrl: string;
  runDir: string;
  executable: string;
  args: string[];
  cwd: string;
  windowTitle?: string | null;
  logPath?: string | null;
}) {
  fs.mkdirSync(input.runDir, { recursive: true });
  const launchScriptPath = path.join(input.runDir, 'launch.bat');
  const logLine = input.logPath
    ? `echo [%DATE% %TIME%] Agent process exited with code %EXIT_CODE% >> ${quoteBatArg(input.logPath)}`
    : 'echo Agent process exited with code %EXIT_CODE%';
  const commandLine = buildLoggedLaunchCommandLine(input.executable, input.args, input.logPath);
  
  const callbackLogLine = input.logPath
    ? `echo [%DATE% %TIME%] completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE% >> ${quoteBatArg(input.logPath)}`
    : 'echo completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%';
  const pshWebhook = `powershell -NoProfile -Command "$exitCode = [int]$env:EXIT_CODE; $success = $env:CALLBACK_SUCCESS -eq 'true'; $errorMessage = $env:CALLBACK_ERROR_MESSAGE; $body = @{ success = $success; exitCode = $exitCode; errorMessage = $errorMessage } | ConvertTo-Json -Compress; Invoke-RestMethod -Uri '${input.apiBaseUrl}/api/tasks/${input.taskId}/agent-runs/${input.runId}/complete' -Method Post -ContentType 'application/json' -Body $body"`;

  fs.writeFileSync(launchScriptPath, [
    '@echo off',
    'setlocal',
    input.windowTitle ? `title ${input.windowTitle}` : '',
    `cd /d ${quoteBatArg(input.cwd)}`,
    input.logPath ? `echo [%DATE% %TIME%] --- agent output start --- >> ${quoteBatArg(input.logPath)}` : '',
    commandLine,
    'set EXIT_CODE=%ERRORLEVEL%',
    input.logPath ? `echo [%DATE% %TIME%] --- agent output end (exit=%EXIT_CODE%) --- >> ${quoteBatArg(input.logPath)}` : '',
    'set CALLBACK_SUCCESS=false',
    'set "CALLBACK_ERROR_MESSAGE="',
    'if "%EXIT_CODE%"=="0" set CALLBACK_SUCCESS=true',
    'if not "%EXIT_CODE%"=="0" set "CALLBACK_ERROR_MESSAGE=Agent process exited with code %EXIT_CODE%"',
    logLine,
    callbackLogLine,
    pshWebhook,
    'echo.',
    'echo Agent process exited with code %EXIT_CODE%. This window remains open for debugging.',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n'), 'utf8');

  return launchScriptPath;
}

export function createCodexLaunchScript(input: {
  runId: string;
  taskId: string;
  apiBaseUrl: string;
  runDir: string;
  executable: string;
  args: string[];
  cwd: string;
  windowTitle?: string | null;
  logPath?: string | null;
}) {
  fs.mkdirSync(input.runDir, { recursive: true });
  const launchScriptPath = path.join(input.runDir, 'launch.bat');
  const logLine = input.logPath
    ? `echo [%DATE% %TIME%] Codex session exited with code %EXIT_CODE% >> ${quoteBatArg(input.logPath)}`
    : 'echo Codex session exited with code %EXIT_CODE%';
  const commandLine = buildLoggedLaunchCommandLine(input.executable, input.args, input.logPath);
  
  const callbackLogLine = input.logPath
    ? `echo [%DATE% %TIME%] completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE% >> ${quoteBatArg(input.logPath)}`
    : 'echo completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%';
  const pshWebhook = `powershell -NoProfile -Command "$exitCode = [int]$env:EXIT_CODE; $success = $env:CALLBACK_SUCCESS -eq 'true'; $errorMessage = $env:CALLBACK_ERROR_MESSAGE; $body = @{ success = $success; exitCode = $exitCode; errorMessage = $errorMessage } | ConvertTo-Json -Compress; Invoke-RestMethod -Uri '${input.apiBaseUrl}/api/tasks/${input.taskId}/agent-runs/${input.runId}/complete' -Method Post -ContentType 'application/json' -Body $body"`;

  fs.writeFileSync(launchScriptPath, [
    '@echo off',
    'setlocal',
    input.windowTitle ? `title ${input.windowTitle}` : '',
    `cd /d ${quoteBatArg(input.cwd)}`,
    input.logPath ? `echo [%DATE% %TIME%] --- agent output start --- >> ${quoteBatArg(input.logPath)}` : '',
    commandLine,
    'set EXIT_CODE=%ERRORLEVEL%',
    input.logPath ? `echo [%DATE% %TIME%] --- agent output end (exit=%EXIT_CODE%) --- >> ${quoteBatArg(input.logPath)}` : '',
    'set CALLBACK_SUCCESS=false',
    'set "CALLBACK_ERROR_MESSAGE="',
    'if "%EXIT_CODE%"=="0" set CALLBACK_SUCCESS=true',
    'if not "%EXIT_CODE%"=="0" set "CALLBACK_ERROR_MESSAGE=Codex process exited with code %EXIT_CODE%"',
    logLine,
    callbackLogLine,
    pshWebhook,
    'echo.',
    'echo Codex interactive session ended. This window remains open for your review.',
    'pause',
    'exit /b %EXIT_CODE%',
    '',
  ].join('\r\n'), 'utf8');

  return launchScriptPath;
}

function readPromptReference(taskId: string, promptPath: string, apiBaseUrl: string) {
  if (promptPath && fs.existsSync(promptPath)) {
    return buildPromptReference(promptPath);
  }
  return `Fetch and follow the DevFlow task prompt from: ${apiBaseUrl}/api/tasks/${taskId}/prompt`;
}

function main() {
  const args = process.argv.slice(2);
  const agentId = args[0]?.toLowerCase();
  const taskId = args[1];
  const localPath = args[2] === 'none' ? '' : args[2];
  const model = args[3] === 'none' ? '' : args[3];
  const effort = args[4] === 'none' ? '' : args[4];
  const runId = args[5] === 'none' ? '' : args[5];
  const promptPath = args[6] === 'none' ? '' : args[6];
  const logPath = args[7] === 'none' ? '' : args[7];
  const paths = normalizeRunnerPaths({ localPath, promptPath, logPath });
  const apiBaseUrl = (args[8] === 'none' || !args[8] ? process.env.DEVFLOW_API_BASE_URL || 'http://localhost:3000' : args[8]).replace(/\/$/, '');
  const executionMode = resolveAgentExecutionMode(process.env.DEVFLOW_AGENT_EXECUTION_MODE);

  if (!agentId || !taskId) {
    console.error('[runner] Missing required arguments: agentId taskId');
    process.exit(1);
  }

  const configPath = path.join(__dirname, '..', 'config', 'agents', `${agentId}.json`);
  if (!fs.existsSync(configPath)) {
    console.error(`[runner] Configuration file not found for agent '${agentId}' at ${configPath}`);
    process.exit(1);
  }

  const config: AgentConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  console.log(`[runner] Loaded configuration for ${config.name}`);

  const launchPlan = resolveAgentLaunchPlan({ agent: config.name, model, effort, executionMode, baseDir: path.join(__dirname, '..') });
  if (!launchPlan.ok) {
    console.error(`[runner] ${launchPlan.error}`);
    appendRunnerLog(paths.logPath, `Launch rejected: ${launchPlan.error}`);
    process.exit(1);
  }

  const promptReference = readPromptReference(taskId, paths.promptPath, apiBaseUrl);
  if (!promptReference) {
    console.error(`[runner] Invalid prompt reference for task ${taskId}`);
    process.exit(1);
  }
  const runDir = paths.logPath ? path.dirname(paths.logPath) : runId ? path.join(getAgentRunsBaseDir(), runId) : getDevFlowAppRoot();
  const agentLaunchConfig = buildAgentLaunchConfig({
    task: { id: taskId, agent: config.name, model, effort },
    project: { localPath: paths.localPath || getDevFlowAppRoot() },
    promptPath: paths.promptPath,
    logPath: paths.logPath,
    runId,
    executionMode,
    apiBaseUrl,
    appRoot: path.join(__dirname, '..'),
    preview: true,
    promptReferenceOverride: promptReference,
  });
  if (agentLaunchConfig.ok === false) {
    console.error(`[runner] ${agentLaunchConfig.error}`);
    appendRunnerLog(paths.logPath, `Launch rejected: ${agentLaunchConfig.error}`);
    process.exit(1);
  }
  const executable = agentLaunchConfig.executable;
  const spawnArgs = agentLaunchConfig.parameters;
  const cwd = agentLaunchConfig.cwd;
  console.log(`[runner] Resolved executable: ${executable}`);
  appendRunnerLog(paths.logPath, agentLaunchConfig.previewText);
  
  let launchScriptPath = '';
  if (config.name === 'Codex') {
    launchScriptPath = createCodexLaunchScript({ 
      runId, 
      taskId, 
      apiBaseUrl, 
      runDir, 
      executable, 
      args: spawnArgs, 
      cwd,
      windowTitle: `${config.name} Agent`,
      logPath: paths.logPath 
    });
  } else {
    launchScriptPath = createAgentLaunchScript({ 
      runId, 
      taskId, 
      apiBaseUrl, 
      runDir, 
      executable, 
      args: spawnArgs, 
      cwd,
      windowTitle: `${config.name} Agent`,
      logPath: paths.logPath 
    });
  }

  const spawnEnv = { ...process.env };
  if (process.env.GITHUB_PERSONAL_ACCESS_TOKEN) {
    spawnEnv.GITHUB_TOKEN = process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  }
  if (process.env.JIRA_API_TOKEN) {
    spawnEnv.JIRA_TOKEN = process.env.JIRA_API_TOKEN;
    spawnEnv.JIRA_PERSONAL_ACCESS_TOKEN = process.env.JIRA_API_TOKEN;
  }

  const configSources: string[] = [];
  if (spawnEnv.GITHUB_PERSONAL_ACCESS_TOKEN) {
    configSources.push(`GitHub Token (length: ${spawnEnv.GITHUB_PERSONAL_ACCESS_TOKEN.length})`);
  }
  if (spawnEnv.JIRA_API_TOKEN) {
    configSources.push(`Jira Token (length: ${spawnEnv.JIRA_API_TOKEN.length})`);
  }
  if (spawnEnv.JIRA_BASE_URL) {
    configSources.push(`Jira Base URL: ${spawnEnv.JIRA_BASE_URL}`);
  }
  if (spawnEnv.JIRA_EMAIL) {
    configSources.push(`Jira Email: ${spawnEnv.JIRA_EMAIL}`);
  }
  console.log(`[runner] Active runtime config: ${configSources.join(', ') || 'No custom tokens set'}`);

  console.log(`[runner] Launching ${config.name} in a new window for run=${runId || 'none'} mode=${executionMode}...`);

  if (!launchScriptPath) {
    console.error(`[runner] Failed to generate launch script.`);
    process.exit(1);
  }
  const finalDispatch = buildLauncherDispatch({
    cwd,
    launchScriptPath,
  });

  appendRunnerLog(paths.logPath, buildLaunchMetadataBlock(launchPlan).trim());
  appendRunnerLog(paths.logPath, `runId=${runId || 'none'}`);
  appendRunnerLog(paths.logPath, `executionMode=${executionMode}`);
  appendRunnerLog(paths.logPath, `cwd=${cwd}`);
  appendRunnerLog(paths.logPath, `resolvedExecutable=${executable}`);
  appendRunnerLog(paths.logPath, `argvPreview=${[finalDispatch.command, ...finalDispatch.args].join(' ')}`);
  appendRunnerLog(paths.logPath, `promptPath=${paths.promptPath || 'none'}`);
  appendRunnerLog(paths.logPath, `launchScriptPath=${launchScriptPath || 'none'}`);

  const child = spawn(finalDispatch.command, finalDispatch.args, {
    detached: true,
    stdio: 'ignore',
    env: spawnEnv,
  });
  
  child.unref();

  console.log(`[runner] Trigger dispatched successfully. Agent launched in new window.`);
  
  // We don't wait for child 'exit' here because it exits immediately.
  // The agent script itself handles completion reporting.
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
