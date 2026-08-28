import 'dotenv/config';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export type OpenAiTunnelAction = 'start' | 'status' | 'stop';

export type OpenAiTunnelPersistedConfig = {
  tunnelId?: string;
  runtimeApiKey?: string;
};

export type OpenAiTunnelOptions = {
  alias: string;
  tunnelId: string;
  mcpServerUrl: string;
  clientBin: string;
  stateDir: string;
  runtimeKeyEnvName: string;
  runtimeApiKey: string;
};

export type OpenAiTunnelLifecycleResult = {
  action: OpenAiTunnelAction;
  ok: boolean;
  running: boolean | null;
  healthy: boolean | null;
  ready: boolean | null;
  reused?: boolean;
  exitCode?: number | null;
  code?: string;
  message: string;
};

export type TunnelClientInvocation = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export type OpenAiTunnelCommandResult = {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown> | null;
  error?: string;
};

export type OpenAiTunnelCommandRunner = (
  invocation: TunnelClientInvocation,
  timeoutMs: number,
) => OpenAiTunnelCommandResult;

const DEFAULT_ALIAS = 'devflow';
const DEFAULT_PORT = 3000;
const DEFAULT_START_TIMEOUT_MS = 60_000;
const DEFAULT_CONTROL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TUNNEL_ID_PATTERN = /^tunnel_[A-Za-z0-9_-]+$/;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function resolveStateDir(value: string | undefined, rootDir: string) {
  const configured = String(value || '').trim();
  if (!configured) return path.join(rootDir, '.devflow', 'tunnel-client');
  return path.isAbsolute(configured) ? configured : path.resolve(rootDir, configured);
}

function selectRuntimeKeyEnvName(env: NodeJS.ProcessEnv) {
  const explicit = String(env.DEVFLOW_TUNNEL_RUNTIME_KEY_ENV || '').trim();
  if (explicit) return explicit;
  if (String(env.CONTROL_PLANE_API_KEY || '').trim()) return 'CONTROL_PLANE_API_KEY';
  if (String(env.OPENAI_API_KEY || '').trim()) return 'OPENAI_API_KEY';
  return 'CONTROL_PLANE_API_KEY';
}

function normalizeAlias(value: string | undefined) {
  const alias = String(value || DEFAULT_ALIAS).trim();
  if (!ALIAS_PATTERN.test(alias)) {
    throw new Error('DEVFLOW_TUNNEL_ALIAS must contain only letters, numbers, dot, underscore, or dash (max 64 chars).');
  }
  return alias;
}

function normalizeTunnelId(value: string | undefined) {
  const tunnelId = String(value || '').trim();
  if (tunnelId && !TUNNEL_ID_PATTERN.test(tunnelId)) {
    throw new Error('OpenAI tunnel id must start with "tunnel_" and contain only URL-safe identifier characters.');
  }
  return tunnelId;
}

function normalizeRuntimeKeyEnvName(value: string) {
  if (!ENV_NAME_PATTERN.test(value)) {
    throw new Error('DEVFLOW_TUNNEL_RUNTIME_KEY_ENV must be a valid environment-variable name.');
  }
  return value;
}

export function resolveOpenAiTunnelOptions(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = projectRoot(),
  persisted: OpenAiTunnelPersistedConfig = {},
): OpenAiTunnelOptions {
  const port = parsePositiveInteger(env.DEVFLOW_PORT || env.PORT, DEFAULT_PORT);
  const runtimeKeyEnvName = normalizeRuntimeKeyEnvName(selectRuntimeKeyEnvName(env));
  return {
    alias: normalizeAlias(env.DEVFLOW_TUNNEL_ALIAS),
    tunnelId: normalizeTunnelId(env.DEVFLOW_OPENAI_TUNNEL_ID || env.CONTROL_PLANE_TUNNEL_ID || persisted.tunnelId),
    mcpServerUrl: `http://127.0.0.1:${port}/mcp`,
    clientBin: String(env.DEVFLOW_TUNNEL_CLIENT_BIN || env.TUNNEL_CLIENT_BIN || 'tunnel-client').trim() || 'tunnel-client',
    stateDir: resolveStateDir(env.TUNNEL_CLIENT_STATE_DIR, rootDir),
    runtimeKeyEnvName,
    runtimeApiKey: String(env[runtimeKeyEnvName] || persisted.runtimeApiKey || '').trim(),
  };
}

export async function loadPersistedOpenAiTunnelConfig(): Promise<OpenAiTunnelPersistedConfig> {
  const { getSettings } = await import('../src/server/repositories/settingsRepository.js');
  const settings = getSettings();
  return {
    tunnelId: settings.openAiTunnelId,
    runtimeApiKey: settings.openAiRuntimeApiKey,
  };
}

export function validateOpenAiTunnelStartOptions(
  options: OpenAiTunnelOptions,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!options.tunnelId) {
    throw new Error('OpenAI tunnel is not configured. Save a Tunnel ID in DevFlow Settings or set DEVFLOW_OPENAI_TUNNEL_ID (or CONTROL_PLANE_TUNNEL_ID).');
  }
  if (!String(env[options.runtimeKeyEnvName] || options.runtimeApiKey || '').trim()) {
    throw new Error(
      `OpenAI tunnel runtime key is missing. Save a Runtime API Key in DevFlow Settings, set ${options.runtimeKeyEnvName}, or point DEVFLOW_TUNNEL_RUNTIME_KEY_ENV at the environment variable that contains the runtime key.`,
    );
  }
}

export function buildOpenAiTunnelInvocation(
  action: OpenAiTunnelAction,
  options: OpenAiTunnelOptions,
  env: NodeJS.ProcessEnv = process.env,
): TunnelClientInvocation {
  const baseArgs = ['runtimes'];
  const args = action === 'start'
    ? [
        ...baseArgs,
        'connect',
        '--alias',
        options.alias,
        '--tunnel-id',
        options.tunnelId,
        '--runtime-api-key',
        `env:${options.runtimeKeyEnvName}`,
        '--mcp-server-url',
        options.mcpServerUrl,
        '--json',
      ]
    : action === 'status'
      ? [...baseArgs, 'status', options.alias, '--json']
      : [...baseArgs, 'stop', options.alias, '--json'];

  const invocationEnv: NodeJS.ProcessEnv = {
    ...env,
    TUNNEL_CLIENT_STATE_DIR: options.stateDir,
  };
  if (!String(invocationEnv[options.runtimeKeyEnvName] || '').trim() && options.runtimeApiKey) {
    invocationEnv[options.runtimeKeyEnvName] = options.runtimeApiKey;
  }

  return {
    command: options.clientBin,
    args,
    env: invocationEnv,
  };
}

function boundedText(value: unknown) {
  const text = String(value || '');
  if (Buffer.byteLength(text, 'utf8') <= MAX_OUTPUT_BYTES) return text;
  return Buffer.from(text, 'utf8').subarray(0, MAX_OUTPUT_BYTES).toString('utf8');
}

function parseJsonPayload(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const parsed = JSON.parse(lines[index]) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Some tunnel-client builds print bounded progress before the final JSON record.
      }
    }
    return null;
  }
}

function findField(value: unknown, keys: Set<string>, depth = 0): unknown {
  if (depth > 5 || !value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 32)) {
      const found = findField(entry, keys, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(record)) {
    if (keys.has(key.toLowerCase())) return entry;
  }
  for (const entry of Object.values(record).slice(0, 64)) {
    const found = findField(entry, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function booleanField(payload: Record<string, unknown> | null, keys: string[]) {
  if (!payload) return null;
  const value = findField(payload, new Set(keys.map((key) => key.toLowerCase())));
  return typeof value === 'boolean' ? value : null;
}

function stringField(payload: Record<string, unknown> | null, keys: string[]) {
  if (!payload) return '';
  const value = findField(payload, new Set(keys.map((key) => key.toLowerCase())));
  return typeof value === 'string' ? value.trim() : '';
}

function inferRunning(payload: Record<string, unknown> | null) {
  const direct = booleanField(payload, ['process_running', 'processRunning', 'running']);
  if (direct !== null) return direct;
  const status = stringField(payload, ['status', 'state']).toLowerCase();
  if (['running', 'ready', 'healthy', 'connected', 'online'].includes(status)) return true;
  if (['stopped', 'exited', 'failed', 'offline', 'not-running'].includes(status)) return false;
  return null;
}

function describeResult(result: OpenAiTunnelCommandResult, fallback: string) {
  const message = stringField(result.payload, ['message', 'summary', 'error', 'detail']);
  if (message) return message;
  const stderr = result.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
  if (stderr) return stderr;
  return fallback;
}

function runTunnelClient(invocation: TunnelClientInvocation, timeoutMs: number): OpenAiTunnelCommandResult {
  fs.mkdirSync(invocation.env.TUNNEL_CLIENT_STATE_DIR as string, { recursive: true });
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.env,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT_BYTES,
  });
  const stdout = boundedText(result.stdout);
  const stderr = boundedText(result.stderr);
  return {
    ok: !result.error && result.status === 0,
    exitCode: result.status,
    stdout,
    stderr,
    payload: parseJsonPayload(stdout),
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function lifecycleFromCommand(
  action: OpenAiTunnelAction,
  result: OpenAiTunnelCommandResult,
  fallbackMessage: string,
): OpenAiTunnelLifecycleResult {
  const running = inferRunning(result.payload);
  const healthy = booleanField(result.payload, ['healthy', 'health_ok', 'healthOk']);
  const ready = booleanField(result.payload, ['ready', 'readiness_ok', 'readinessOk']);
  return {
    action,
    ok: result.ok,
    running,
    healthy,
    ready,
    exitCode: result.exitCode,
    ...(result.error ? { code: result.error.includes('ENOENT') ? 'TUNNEL_CLIENT_NOT_FOUND' : 'TUNNEL_CLIENT_EXEC_FAILED' } : {}),
    message: result.error || describeResult(result, fallbackMessage),
  };
}

function isMissingRuntime(result: OpenAiTunnelCommandResult) {
  const text = `${result.stdout}\n${result.stderr}\n${result.error || ''}`.toLowerCase();
  return /not found|unknown alias|no runtime|does not exist|missing runtime/.test(text);
}

export function getOpenAiTunnelStatus(
  options: OpenAiTunnelOptions = resolveOpenAiTunnelOptions(),
  env: NodeJS.ProcessEnv = process.env,
  runner: OpenAiTunnelCommandRunner = runTunnelClient,
): OpenAiTunnelLifecycleResult {
  const result = runner(buildOpenAiTunnelInvocation('status', options, env), DEFAULT_CONTROL_TIMEOUT_MS);
  if (!result.ok && isMissingRuntime(result)) {
    return {
      action: 'status',
      ok: true,
      running: false,
      healthy: null,
      ready: null,
      exitCode: result.exitCode,
      message: `OpenAI tunnel runtime "${options.alias}" is not running on this machine.`,
    };
  }
  return lifecycleFromCommand('status', result, `OpenAI tunnel runtime "${options.alias}" status read completed.`);
}

export function startOpenAiTunnel(
  options: OpenAiTunnelOptions = resolveOpenAiTunnelOptions(),
  env: NodeJS.ProcessEnv = process.env,
  runner: OpenAiTunnelCommandRunner = runTunnelClient,
): OpenAiTunnelLifecycleResult {
  try {
    validateOpenAiTunnelStartOptions(options, env);
  } catch (error) {
    return {
      action: 'start',
      ok: false,
      running: false,
      healthy: null,
      ready: null,
      code: 'TUNNEL_CONFIG_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const before = getOpenAiTunnelStatus(options, env, runner);
  if (before.ok && before.running === true) {
    return { ...before, action: 'start', reused: true, message: `Reusing OpenAI tunnel runtime "${options.alias}". ${before.message}` };
  }

  const connect = runner(buildOpenAiTunnelInvocation('start', options, env), DEFAULT_START_TIMEOUT_MS);
  if (!connect.ok) {
    const afterFailure = getOpenAiTunnelStatus(options, env, runner);
    if (afterFailure.ok && afterFailure.running === true) {
      return {
        ...afterFailure,
        action: 'start',
        reused: true,
        message: `OpenAI tunnel runtime "${options.alias}" is already running.`,
      };
    }
    return lifecycleFromCommand('start', connect, `OpenAI tunnel runtime "${options.alias}" failed to connect.`);
  }

  const after = getOpenAiTunnelStatus(options, env, runner);
  if (!after.ok) {
    return {
      ...after,
      action: 'start',
      ok: false,
      message: `OpenAI tunnel connect command succeeded, but runtime status could not be confirmed: ${after.message}`,
    };
  }
  if (after.running === false) {
    return {
      ...after,
      action: 'start',
      ok: false,
      code: 'TUNNEL_NOT_RUNNING',
      message: `OpenAI tunnel connect command completed, but runtime "${options.alias}" is not running.`,
    };
  }
  return {
    ...after,
    action: 'start',
    ok: true,
    reused: false,
    message: `OpenAI tunnel runtime "${options.alias}" is connected to ${options.mcpServerUrl}.`,
  };
}

export function stopOpenAiTunnel(
  options: OpenAiTunnelOptions = resolveOpenAiTunnelOptions(),
  env: NodeJS.ProcessEnv = process.env,
  runner: OpenAiTunnelCommandRunner = runTunnelClient,
): OpenAiTunnelLifecycleResult {
  const before = getOpenAiTunnelStatus(options, env, runner);
  if (before.ok && before.running === false) {
    return { ...before, action: 'stop', message: `OpenAI tunnel runtime "${options.alias}" is already stopped.` };
  }

  const stop = runner(buildOpenAiTunnelInvocation('stop', options, env), DEFAULT_CONTROL_TIMEOUT_MS);
  if (!stop.ok && isMissingRuntime(stop)) {
    return {
      action: 'stop',
      ok: true,
      running: false,
      healthy: null,
      ready: null,
      exitCode: stop.exitCode,
      message: `OpenAI tunnel runtime "${options.alias}" is already stopped.`,
    };
  }
  if (!stop.ok) return lifecycleFromCommand('stop', stop, `OpenAI tunnel runtime "${options.alias}" failed to stop.`);

  const after = getOpenAiTunnelStatus(options, env, runner);
  if (after.ok && after.running === false) {
    return { ...after, action: 'stop', message: `OpenAI tunnel runtime "${options.alias}" stopped.` };
  }
  if (!after.ok) {
    return {
      ...after,
      action: 'stop',
      ok: false,
      message: `OpenAI tunnel stop command completed, but stopped state could not be confirmed: ${after.message}`,
    };
  }
  return {
    ...after,
    action: 'stop',
    ok: false,
    code: 'TUNNEL_STILL_RUNNING',
    message: `OpenAI tunnel stop command completed, but runtime "${options.alias}" still reports running.`,
  };
}

function printResult(result: OpenAiTunnelLifecycleResult) {
  console.log(JSON.stringify(result, null, 2));
}

async function syncSupervisorTunnelResult(result: OpenAiTunnelLifecycleResult) {
  const supervisor = await import('../src/lib/devFlowSupervisor.js');
  const state = supervisor.readDevFlowSupervisorState();
  if (!state) return;

  const now = new Date().toISOString();
  const previous = state.processes.tunnel;
  const processStatus = result.ok
    ? result.action === 'stop' || result.running === false
      ? 'stopped'
      : result.running === true || result.action === 'start'
        ? 'running'
        : previous?.status || 'starting'
    : result.action === 'status' && previous?.status === 'running'
      ? 'running'
      : 'failed';

  supervisor.updateDevFlowSupervisorProcess('tunnel', {
    status: processStatus,
    ...(processStatus === 'running' && !previous?.startedAt ? { startedAt: now } : {}),
    ...(processStatus === 'stopped' ? { lastExitAt: now } : {}),
    restartAttempt: 0,
    nextRetryAt: undefined,
    message: result.message,
  }, now);

  const health = !result.ok
    ? {
        status: result.action === 'status' && previous?.status === 'running' ? 'degraded' as const : 'down' as const,
        lastCheckedAt: now,
        lastFailureAt: now,
        lastErrorCode: result.code || 'TUNNEL_CLIENT_COMMAND_FAILED',
        lastErrorClass: 'tunnel-client',
        message: result.message,
      }
    : result.action === 'stop' || result.running === false
      ? {
          status: 'down' as const,
          lastCheckedAt: now,
          message: result.message,
        }
      : result.healthy === false || result.ready === false
        ? {
            status: 'degraded' as const,
            lastCheckedAt: now,
            lastFailureAt: now,
            lastErrorClass: 'tunnel-health',
            message: result.message,
          }
        : result.healthy === true || result.ready === true
          ? {
              status: 'healthy' as const,
              lastCheckedAt: now,
              lastSuccessAt: now,
              message: result.message,
            }
          : {
              status: 'unknown' as const,
              lastCheckedAt: now,
              message: result.message,
            };

  supervisor.updateDevFlowSupervisorTunnelHealth(health, now);
}

async function runCli() {
  const action = String(process.argv[2] || 'status').trim().toLowerCase() as OpenAiTunnelAction;
  let result: OpenAiTunnelLifecycleResult;
  try {
    const persisted = action === 'start' ? await loadPersistedOpenAiTunnelConfig() : {};
    const options = resolveOpenAiTunnelOptions(process.env, undefined, persisted);
    result = action === 'start'
      ? startOpenAiTunnel(options)
      : action === 'stop'
        ? stopOpenAiTunnel(options)
        : action === 'status'
          ? getOpenAiTunnelStatus(options)
          : {
              action: 'status',
              ok: false,
              running: null,
              healthy: null,
              ready: null,
              code: 'TUNNEL_ACTION_INVALID',
              message: 'Usage: tsx scripts/openai-tunnel.ts <start|status|stop>',
            };
  } catch (error) {
    result = {
      action: ['start', 'status', 'stop'].includes(action) ? action : 'status',
      ok: false,
      running: null,
      healthy: null,
      ready: null,
      code: 'TUNNEL_CONFIG_INVALID',
      message: error instanceof Error ? error.message : String(error),
    };
  }

  await syncSupervisorTunnelResult(result);
  printResult(result);
  if (!result.ok) process.exitCode = 1;
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  runCli().catch((error) => {
    console.error(JSON.stringify({
      action: String(process.argv[2] || 'status'),
      ok: false,
      code: 'TUNNEL_CLI_FAILED',
      message: error instanceof Error ? error.message : String(error),
    }, null, 2));
    process.exitCode = 1;
  });
}
