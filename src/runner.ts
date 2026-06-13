import * as fs from 'fs';
import * as path from 'path';
import { spawn, execSync } from 'child_process';
import { fileURLToPath, pathToFileURL } from 'url';
import { buildPromptReference, getDevFlowAppRoot, getAgentRunsBaseDir, resolveAgentExecutionMode, type AgentExecutionMode } from './server/services/agentRunService';
import { buildLaunchMetadataBlock, resolveAgentLaunchPlan, type FileAgentConfig } from './server/services/agentLaunchConfig';

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

function resolveEnvVariables(str: string): string {
  return str.replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
}

function resolveExecutable(executables: AgentConfig['executables']): string | null {
  for (const exec of executables) {
    if (exec.type === 'env') {
      const val = process.env[exec.value];
      if (val && fs.existsSync(val)) return val;
    } else if (exec.type === 'path') {
      const val = resolveEnvVariables(exec.value);
      if (val && fs.existsSync(val)) return val;
    } else if (exec.type === 'command') {
      try {
        const out = execSync(`where ${exec.value} 2>nul`, { encoding: 'utf8' });
        const lines = out.trim().split('\n');
        if (lines.length > 0 && fs.existsSync(lines[0].trim())) {
          return lines[0].trim();
        }
      } catch (e) {
        // Not found
      }
    }
  }
  return null;
}

function quoteBatArg(value: string) {
  return `"${value.replace(/"/g, '""')}"`;
}

function buildLaunchCommandLine(executable: string, args: string[]) {
  const quotedExecutable = quoteBatArg(executable);
  const quotedArgs = args.map(quoteBatArg).join(' ');
  const isBatchScript = /\.(cmd|bat)$/i.test(executable);
  return `${isBatchScript ? 'call ' : ''}${quotedExecutable}${quotedArgs ? ` ${quotedArgs}` : ''}`;
}

export function buildWindowsStartCommand(input: {
  cwd: string;
  launchScriptPath: string;
}) {
  return [
    'start',
    '""',
    '/d',
    quoteBatArg(input.cwd),
    'cmd.exe',
    '/k',
    'call',
    quoteBatArg(input.launchScriptPath),
  ].join(' ');
}

function appendRunnerLog(logPath: string | null | undefined, message: string) {
  if (!logPath) return;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
}

function appendFlagValue(args: string[], flag: string | string[], value: string) {
  const flagParts = Array.isArray(flag) ? flag : [flag];
  const valueFlag = flagParts.at(-1);
  if (!valueFlag) return;

  args.push(...flagParts.slice(0, -1));
  if (valueFlag.endsWith('=')) {
    args.push(`${valueFlag}${value}`);
  } else {
    args.push(valueFlag, value);
  }
}

export function mapModelForAgent(config: Pick<AgentConfig, 'modelMap'>, model: string) {
  return config.modelMap?.[model] || '';
}

export function buildAgentCliArgs(input: BuildAgentCliArgsInput) {
  const { config, localPath, effort, promptReference, executionMode } = input;
  const model = input.model ? mapModelForAgent(config, input.model) : '';
  const spawnArgs: string[] = [];

  if (localPath && config.flags.workingDir) {
    spawnArgs.push(config.flags.workingDir, localPath);
  }

  if (model) {
    if (config.flags.model) {
      spawnArgs.push(config.flags.model, model);
    } else {
      console.warn(`[runner] WARNING: ${config.name} does not support model flag natively via config.`);
    }
  }

  if (effort) {
    if (config.flags.effort) {
      appendFlagValue(spawnArgs, config.flags.effort, effort);
    } else if (config.promptFallback?.effort) {
      console.warn(`[runner] WARNING: ${config.name} config states no effort flag. Using prompt fallback.`);
    }
  }

  if (config.flags.interactiveArgs) {
    spawnArgs.push(...config.flags.interactiveArgs);
  }

  const modeArgs = config.executionModes?.[executionMode]?.args;
  if (modeArgs) {
    spawnArgs.push(...modeArgs);
  } else if (executionMode === 'full' && config.flags.alwaysAllow) {
    spawnArgs.push(config.flags.alwaysAllow);
  }

  spawnArgs.push(promptReference);
  return spawnArgs;
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
  const commandLine = buildLaunchCommandLine(input.executable, input.args);
  
  const callbackLogLine = input.logPath
    ? `echo [%DATE% %TIME%] completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE% >> ${quoteBatArg(input.logPath)}`
    : 'echo completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%';
  const pshWebhook = `powershell -NoProfile -Command "$exitCode = [int]$env:EXIT_CODE; $success = $env:CALLBACK_SUCCESS -eq 'true'; $errorMessage = $env:CALLBACK_ERROR_MESSAGE; $body = @{ success = $success; exitCode = $exitCode; errorMessage = $errorMessage } | ConvertTo-Json -Compress; Invoke-RestMethod -Uri '${input.apiBaseUrl}/api/tasks/${input.taskId}/agent-runs/${input.runId}/complete' -Method Post -ContentType 'application/json' -Body $body"`;

  fs.writeFileSync(launchScriptPath, [
    '@echo off',
    'setlocal',
    input.windowTitle ? `title ${input.windowTitle}` : '',
    `cd /d ${quoteBatArg(input.cwd)}`,
    commandLine,
    'set EXIT_CODE=%ERRORLEVEL%',
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
  const commandLine = buildLaunchCommandLine(input.executable, input.args);
  
  const callbackLogLine = input.logPath
    ? `echo [%DATE% %TIME%] completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE% >> ${quoteBatArg(input.logPath)}`
    : 'echo completionCallback success=%CALLBACK_SUCCESS% exitCode=%EXIT_CODE% errorMessage=%CALLBACK_ERROR_MESSAGE%';
  const pshWebhook = `powershell -NoProfile -Command "$exitCode = [int]$env:EXIT_CODE; $success = $env:CALLBACK_SUCCESS -eq 'true'; $errorMessage = $env:CALLBACK_ERROR_MESSAGE; $body = @{ success = $success; exitCode = $exitCode; errorMessage = $errorMessage } | ConvertTo-Json -Compress; Invoke-RestMethod -Uri '${input.apiBaseUrl}/api/tasks/${input.taskId}/agent-runs/${input.runId}/complete' -Method Post -ContentType 'application/json' -Body $body"`;

  fs.writeFileSync(launchScriptPath, [
    '@echo off',
    'setlocal',
    input.windowTitle ? `title ${input.windowTitle}` : '',
    `cd /d ${quoteBatArg(input.cwd)}`,
    commandLine,
    'set EXIT_CODE=%ERRORLEVEL%',
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
    appendRunnerLog(logPath, `Launch rejected: ${launchPlan.error}`);
    process.exit(1);
  }

  const executable = resolveExecutable(config.executables);
  if (!executable) {
    console.error(`[runner] Executable not found for ${config.name}. Checked:`, config.executables);
    appendRunnerLog(logPath, `Executable not found for ${config.name}. Checked configured env/path/command sources.`);
    process.exit(1);
  }
  console.log(`[runner] Resolved executable: ${executable}`);

  const promptReference = readPromptReference(taskId, promptPath, apiBaseUrl);
  if (!promptReference) {
    console.error(`[runner] Invalid prompt reference for task ${taskId}`);
    process.exit(1);
  }

  const spawnArgs = buildAgentCliArgs({ config, localPath, model, effort, promptReference, executionMode });
  const runDir = logPath ? path.dirname(logPath) : runId ? path.join(getAgentRunsBaseDir(), runId) : getDevFlowAppRoot();
  
  let launchScriptPath = '';
  if (config.name === 'Codex') {
    launchScriptPath = createCodexLaunchScript({ 
      runId, 
      taskId, 
      apiBaseUrl, 
      runDir, 
      executable, 
      args: spawnArgs, 
      cwd: localPath || getDevFlowAppRoot(), 
      windowTitle: `${config.name} Agent`,
      logPath 
    });
  } else {
    launchScriptPath = createAgentLaunchScript({ 
      runId, 
      taskId, 
      apiBaseUrl, 
      runDir, 
      executable, 
      args: spawnArgs, 
      cwd: localPath || getDevFlowAppRoot(), 
      windowTitle: `${config.name} Agent`,
      logPath 
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

  // We need to launch the agent in a new visible console window, starting in the localPath.
  const cwd = localPath || getDevFlowAppRoot();

  let finalCmd = '';
  let finalArgs: string[] = [];

  if (launchScriptPath) {
    if (config.name === 'Codex') {
      finalCmd = 'cmd.exe';
      finalArgs = [
        '/s',
        '/c',
        `"start "" /d ${quoteBatArg(cwd)} ${quoteBatArg(launchScriptPath)}"`
      ];
    } else {
      finalCmd = 'cmd.exe';
      finalArgs = ['/d', '/s', '/c', buildWindowsStartCommand({
        cwd,
        launchScriptPath,
      })];
    }
  } else {
    console.error(`[runner] Failed to generate launch script.`);
    process.exit(1);
  }

  appendRunnerLog(logPath, buildLaunchMetadataBlock(launchPlan).trim());
  appendRunnerLog(logPath, `runId=${runId || 'none'}`);
  appendRunnerLog(logPath, `executionMode=${executionMode}`);
  appendRunnerLog(logPath, `cwd=${cwd}`);
  appendRunnerLog(logPath, `resolvedExecutable=${executable}`);
  appendRunnerLog(logPath, `argvPreview=${[finalCmd, ...finalArgs].join(' ')}`);
  appendRunnerLog(logPath, `promptPath=${promptPath || 'none'}`);
  appendRunnerLog(logPath, `launchScriptPath=${launchScriptPath || 'none'}`);

  const child = spawn(finalCmd, finalArgs, {
    detached: true,
    stdio: 'ignore',
    env: spawnEnv,
    windowsVerbatimArguments: config.name === 'Codex'
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
