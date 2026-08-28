import 'dotenv/config';
import fs from 'node:fs';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  DEVFLOW_RESTART_EXIT_CODE,
  DEVFLOW_RESTART_SUPERVISOR_ENV,
  DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV,
  DEVFLOW_RESTART_SUPERVISOR_START_ALL,
  type DevFlowRestartState,
  markDevFlowRestartFailed,
  markDevFlowRestartRestarting,
  readDevFlowRestartState,
} from '../src/lib/devFlowRestart';
import {
  acquireDevFlowRuntimeOwnership,
  assertDevFlowRuntimePortAvailable,
  type DevFlowRuntimeOwner,
} from '../src/lib/devFlowRuntimeOwnership';
import {
  createDevFlowSupervisorState,
  readDevFlowSupervisorState,
  updateDevFlowSupervisorProcess,
  updateDevFlowSupervisorState,
  updateDevFlowSupervisorTunnelHealth,
  writeDevFlowSupervisorState,
  type DevFlowSupervisorProcessLabel,
} from '../src/lib/devFlowSupervisor';
import {
  loadPersistedOpenAiTunnelConfig,
  resolveOpenAiTunnelOptions,
  startOpenAiTunnel,
  stopOpenAiTunnel,
  type OpenAiTunnelLifecycleResult,
  type OpenAiTunnelOptions,
} from './openai-tunnel';

type StartAllOptions = {
  port: number;
  openBrowser: boolean;
  openBrowserDelayMs: number;
  tunnelStartupWaitMs: number;
};

type ManagedProcess = {
  label: 'server';
  command: string;
  args: string[];
  env?: Record<string, string>;
};

type StartAllMode = 'all' | 'server-only';
type RuntimeLifecycleStatus = 'starting' | 'running' | 'stopping' | 'failed';

type StartAllPlan = {
  mode: StartAllMode;
  appUrl: string;
  openBrowser: boolean;
  openBrowserDelayMs: number;
  processes: ManagedProcess[];
};

const DEFAULT_PORT = 3000;
const DEFAULT_BROWSER_DELAY_MS = 4000;
const DEFAULT_TUNNEL_STARTUP_WAIT_MS = 30_000;
const MAX_TUNNEL_STARTUP_WAIT_MS = 120_000;

function parsePositiveInteger(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function executableFor(command: string) {
  return process.platform === 'win32' ? `${command}.cmd` : command;
}

export function buildNpmInvocation(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const npmExecPath = String(env.npm_execpath || '').trim();
  if (npmExecPath) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }

  if (process.platform === 'win32') {
    const installedNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(installedNpmCli)) {
      return { command: process.execPath, args: [installedNpmCli, ...args] };
    }
  }

  return { command: executableFor('npm'), args };
}

export function resolveStartAllOptions(env: NodeJS.ProcessEnv = process.env): StartAllOptions {
  return {
    port: parsePositiveInteger(env.DEVFLOW_PORT || env.PORT, DEFAULT_PORT),
    openBrowser: parseBoolean(env.DEVFLOW_OPEN_BROWSER, true),
    openBrowserDelayMs: parsePositiveInteger(env.DEVFLOW_OPEN_BROWSER_DELAY_MS, DEFAULT_BROWSER_DELAY_MS),
    tunnelStartupWaitMs: Math.min(
      parsePositiveInteger(env.DEVFLOW_TUNNEL_STARTUP_WAIT_MS, DEFAULT_TUNNEL_STARTUP_WAIT_MS),
      MAX_TUNNEL_STARTUP_WAIT_MS,
    ),
  };
}

export function buildStartAllPlan(
  options: StartAllOptions,
  supervisorToken: string = randomUUID(),
  mode: StartAllMode = 'all',
): StartAllPlan {
  const serverInvocation = buildNpmInvocation(['run', 'dev:server']);
  const server: ManagedProcess = {
    label: 'server',
    command: serverInvocation.command,
    args: serverInvocation.args,
    env: {
      [DEVFLOW_RESTART_SUPERVISOR_ENV]: DEVFLOW_RESTART_SUPERVISOR_START_ALL,
      [DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV]: supervisorToken,
      DISABLE_HMR: process.env.DISABLE_HMR === 'false' ? 'false' : 'true',
    },
  };

  return {
    mode,
    appUrl: `http://localhost:${options.port}`,
    openBrowser: mode === 'all' ? options.openBrowser : false,
    openBrowserDelayMs: options.openBrowserDelayMs,
    processes: [server],
  };
}

function openUrl(url: string) {
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

function runSetup() {
  console.log('[start-all] Running setup...');
  const npmSetup = buildNpmInvocation(['run', 'setup']);
  const result = spawnSync(npmSetup.command, npmSetup.args, { stdio: 'inherit', env: process.env });
  if (result.status !== 0) {
    const error = new Error(`DevFlow setup failed with exit code ${result.status ?? 1}.`) as Error & { exitCode?: number };
    error.exitCode = result.status ?? 1;
    throw error;
  }
}

export function shouldRestartServerProcess(input: {
  label: string;
  exitCode: number | null;
  supervisorToken: string | undefined;
  shuttingDown: boolean;
  restartState: Pick<DevFlowRestartState, 'status' | 'supervisor' | 'supervisorToken'> | null;
}) {
  return !input.shuttingDown
    && input.label === 'server'
    && input.exitCode === DEVFLOW_RESTART_EXIT_CODE
    && input.restartState?.status === 'accepted'
    && input.restartState.supervisor === DEVFLOW_RESTART_SUPERVISOR_START_ALL
    && Boolean(input.supervisorToken)
    && input.restartState.supervisorToken === input.supervisorToken;
}

function startProcess(processConfig: ManagedProcess, callbacks: {
  onExit?: (child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (child: ChildProcessWithoutNullStreams, error: Error) => void;
} = {}): ChildProcessWithoutNullStreams {
  console.log(`[start-all] Starting ${processConfig.label}: ${processConfig.command} ${processConfig.args.join(' ')}`);
  const child = spawn(processConfig.command, processConfig.args, {
    env: { ...process.env, ...(processConfig.env || {}) },
    shell: false,
  });

  child.stdout.on('data', (chunk) => process.stdout.write(`[${processConfig.label}] ${String(chunk)}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[${processConfig.label}] ${String(chunk)}`));
  child.on('exit', (code, signal) => callbacks.onExit?.(child, code, signal));
  child.on('error', (error) => callbacks.onError?.(child, error));
  return child;
}

function stopManagedProcessTree(child: ChildProcessWithoutNullStreams) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
    });
    if (result.status === 0 || child.exitCode !== null) return;
  }
  if (!child.killed) child.kill();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitForLocalApi(baseUrl: string, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  const url = new URL('/api/capabilities', baseUrl).toString();
  let lastMessage = 'DevFlow API has not answered yet.';
  while (Date.now() < deadline) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1_500);
    timer.unref();
    try {
      const response = await fetchImpl(url, { signal: controller.signal, redirect: 'manual' });
      if (response.ok) return { ok: true as const, message: `DevFlow API is ready at ${baseUrl}.` };
      lastMessage = `DevFlow API returned HTTP ${response.status}.`;
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
    await sleep(250);
  }
  return { ok: false as const, message: `Timed out waiting for DevFlow API: ${lastMessage}` };
}

function tunnelOptionsForAppUrl(
  appUrl: string,
  persisted: Parameters<typeof resolveOpenAiTunnelOptions>[2] = {},
): OpenAiTunnelOptions {
  const options = resolveOpenAiTunnelOptions(process.env, undefined, persisted);
  return {
    ...options,
    mcpServerUrl: new URL('/mcp', appUrl).toString(),
  };
}

function tunnelHealthFromResult(result: OpenAiTunnelLifecycleResult) {
  const now = new Date().toISOString();
  if (!result.ok || result.running === false) {
    return {
      status: 'down' as const,
      lastCheckedAt: now,
      lastFailureAt: now,
      ...(result.code ? { lastErrorCode: result.code } : {}),
      lastErrorClass: 'tunnel-client',
      message: result.message,
    };
  }
  if (result.healthy === false || result.ready === false) {
    return {
      status: 'degraded' as const,
      lastCheckedAt: now,
      lastFailureAt: now,
      lastErrorClass: 'tunnel-health',
      message: result.message,
    };
  }
  if (result.healthy === true || result.ready === true) {
    return {
      status: 'healthy' as const,
      lastCheckedAt: now,
      lastSuccessAt: now,
      message: result.message,
    };
  }
  return {
    status: 'unknown' as const,
    lastCheckedAt: now,
    lastSuccessAt: now,
    message: `${result.message} Tunnel-client did not expose a definitive health boolean in this status response.`,
  };
}

function ensureSupervisorStateForReusedRuntime(owner: DevFlowRuntimeOwner) {
  if (readDevFlowSupervisorState()) return;
  const state = createDevFlowSupervisorState({ mode: owner.mode, processLabels: ['server'] });
  state.processes.server = {
    label: 'server',
    status: 'running',
    restartAttempt: 0,
    message: `Reused healthy DevFlow runtime ${owner.instanceId}.`,
  };
  writeDevFlowSupervisorState(state);
}

function recordTunnelStarting(message: string) {
  updateDevFlowSupervisorProcess('tunnel', {
    status: 'starting',
    restartAttempt: 0,
    nextRetryAt: undefined,
    message,
  });
  updateDevFlowSupervisorTunnelHealth({
    status: 'unknown',
    lastCheckedAt: new Date().toISOString(),
    message,
  });
}

function recordTunnelStartResult(result: OpenAiTunnelLifecycleResult) {
  updateDevFlowSupervisorProcess('tunnel', {
    status: result.ok && result.running !== false ? 'running' : 'failed',
    startedAt: result.ok && result.running !== false ? new Date().toISOString() : undefined,
    restartAttempt: 0,
    nextRetryAt: undefined,
    message: result.message,
  });
  updateDevFlowSupervisorTunnelHealth(tunnelHealthFromResult(result));
}

function recordTunnelStopResult(result: OpenAiTunnelLifecycleResult) {
  const now = new Date().toISOString();
  updateDevFlowSupervisorProcess('tunnel', {
    status: result.ok ? 'stopped' : 'failed',
    lastExitAt: now,
    restartAttempt: 0,
    nextRetryAt: undefined,
    message: result.message,
  });
  updateDevFlowSupervisorTunnelHealth({
    status: result.ok ? 'down' : 'degraded',
    lastCheckedAt: now,
    ...(result.ok ? {} : { lastFailureAt: now, lastErrorCode: result.code || 'TUNNEL_STOP_FAILED', lastErrorClass: 'tunnel-client' }),
    message: result.message,
  });
}

async function startTunnelForRuntime(appUrl: string) {
  const persisted = await loadPersistedOpenAiTunnelConfig();
  const options = tunnelOptionsForAppUrl(appUrl, persisted);
  recordTunnelStarting(`Starting OpenAI tunnel runtime "${options.alias}".`);
  const result = startOpenAiTunnel(options);
  recordTunnelStartResult(result);
  if (result.ok) console.log(`[tunnel] ${result.message}`);
  else console.error(`[tunnel] ${result.message}`);
  return result;
}

async function stopTunnelForRuntime(appUrl: string) {
  const options = tunnelOptionsForAppUrl(appUrl);
  const result = stopOpenAiTunnel(options);
  recordTunnelStopResult(result);
  if (result.ok) console.log(`[tunnel] ${result.message}`);
  else console.error(`[tunnel] ${result.message}`);
  return result;
}

export async function startAll(mode: StartAllMode = 'all') {
  const options = resolveStartAllOptions();
  const plan = buildStartAllPlan(options, randomUUID(), mode);
  let lifecycleStatus: RuntimeLifecycleStatus = 'starting';
  let shutdownRequested = false;
  let shutdownHandler: (() => void) | null = null;

  const ownership = await acquireDevFlowRuntimeOwnership({
    mode,
    appUrl: plan.appUrl,
    getLifecycleStatus: () => lifecycleStatus,
    onShutdown: () => {
      shutdownRequested = true;
      shutdownHandler?.();
    },
  });

  if (ownership.status === 'reused') {
    console.log(`[start-all] Reusing healthy DevFlow runtime ${ownership.owner.instanceId} (pid=${ownership.owner.pid}).`);
    ensureSupervisorStateForReusedRuntime(ownership.owner);
    if (mode === 'all') {
      await startTunnelForRuntime(ownership.owner.appUrl);
      if (options.openBrowser) openUrl(ownership.owner.appUrl);
    }
    return { reused: true, owner: ownership.owner };
  }

  if (ownership.recoveredStaleOwner) {
    console.warn('[start-all] Recovered stale DevFlow runtime ownership before startup.');
  }

  try {
    await assertDevFlowRuntimePortAvailable(options.port);
    if (mode === 'all') runSetup();
  } catch (error) {
    lifecycleStatus = 'failed';
    await ownership.release();
    throw error;
  }

  const children = new Map<DevFlowSupervisorProcessLabel, ChildProcessWithoutNullStreams>();
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;

  writeDevFlowSupervisorState(createDevFlowSupervisorState({
    mode,
    processLabels: mode === 'all' ? ['server', 'tunnel'] : ['server'],
  }));

  let launchServer: () => ChildProcessWithoutNullStreams;
  launchServer = () => {
    const processConfig = plan.processes[0];
    const child = startProcess(processConfig, {
      onExit: (exitedChild, code, signal) => {
        if (children.get('server') !== exitedChild) return;
        children.delete('server');
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
        const restartState = readDevFlowRestartState();
        const supervisorToken = processConfig.env?.[DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV];

        if (shouldRestartServerProcess({
          label: 'server',
          exitCode: code,
          supervisorToken,
          shuttingDown,
          restartState,
        })) {
          lifecycleStatus = 'starting';
          updateDevFlowSupervisorProcess('server', {
            status: 'restarting',
            pid: undefined,
            lastExitAt: new Date().toISOString(),
            lastExitCode: code,
            lastSignal: signal,
            message: `Restart ticket ${restartState!.ticket} accepted; relaunching DevFlow server while preserving the OpenAI tunnel runtime.`,
          });
          try {
            const replacement = launchServer();
            if (!replacement.pid) {
              lifecycleStatus = 'failed';
              markDevFlowRestartFailed(restartState!.ticket, 'Restart supervisor could not resolve the replacement server process id.');
              return;
            }
            markDevFlowRestartRestarting(restartState!.ticket, replacement.pid);
          } catch (error) {
            lifecycleStatus = 'failed';
            const message = error instanceof Error ? error.message : String(error);
            markDevFlowRestartFailed(restartState!.ticket, `Restart supervisor failed to relaunch DevFlow: ${message}`);
          }
          return;
        }

        lifecycleStatus = shuttingDown ? 'stopping' : 'failed';
        updateDevFlowSupervisorProcess('server', {
          status: shuttingDown ? 'stopped' : 'failed',
          pid: undefined,
          lastExitAt: new Date().toISOString(),
          lastExitCode: code,
          lastSignal: signal,
          message: shuttingDown ? 'DevFlow server stopped during intentional supervisor shutdown.' : `DevFlow server exited with ${detail}.`,
        });

        if (!shuttingDown && restartState?.status === 'accepted' && restartState.supervisorToken === supervisorToken) {
          markDevFlowRestartFailed(restartState.ticket, `DevFlow exited with ${detail} before restart handoff completed.`);
        } else if (!shuttingDown && restartState?.status === 'restarting' && restartState.replacementPid === exitedChild.pid) {
          markDevFlowRestartFailed(restartState.ticket, `Replacement DevFlow server exited with ${detail} before becoming healthy.`);
        }
      },
      onError: (failedChild, error) => {
        if (children.get('server') !== failedChild) return;
        children.delete('server');
        lifecycleStatus = shuttingDown ? 'stopping' : 'failed';
        updateDevFlowSupervisorProcess('server', {
          status: shuttingDown ? 'stopped' : 'failed',
          pid: undefined,
          message: `DevFlow server failed to start: ${error.message}`,
        });
        const restartState = readDevFlowRestartState();
        if (
          !shuttingDown
          && restartState?.status === 'restarting'
          && restartState.replacementPid === failedChild.pid
        ) {
          markDevFlowRestartFailed(restartState.ticket, `Replacement DevFlow server failed to start: ${error.message}`);
        }
      },
    });

    children.set('server', child);
    updateDevFlowSupervisorProcess('server', {
      status: child.pid ? 'running' : 'starting',
      ...(child.pid ? { pid: child.pid } : { pid: undefined }),
      startedAt: new Date().toISOString(),
      restartAttempt: 0,
      nextRetryAt: undefined,
      message: child.pid ? 'DevFlow server child process is running.' : 'DevFlow server child process is starting.',
    });
    if (child.pid) lifecycleStatus = 'running';
    return child;
  };

  launchServer();

  if (mode === 'all') {
    const readiness = await waitForLocalApi(plan.appUrl, options.tunnelStartupWaitMs);
    if (readiness.ok) {
      await startTunnelForRuntime(plan.appUrl);
    } else {
      const failed: OpenAiTunnelLifecycleResult = {
        action: 'start',
        ok: false,
        running: false,
        healthy: null,
        ready: null,
        code: 'DEVFLOW_API_NOT_READY',
        message: `${readiness.message} OpenAI tunnel startup was skipped.`,
      };
      recordTunnelStartResult(failed);
      console.error(`[tunnel] ${failed.message}`);
    }
  }

  if (plan.openBrowser) setTimeout(() => openUrl(plan.appUrl), plan.openBrowserDelayMs);

  const shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      lifecycleStatus = 'stopping';
      updateDevFlowSupervisorState({ shuttingDown: true });

      const state = readDevFlowSupervisorState();
      if (state?.processes.tunnel) {
        await stopTunnelForRuntime(plan.appUrl);
      }

      const serverChild = children.get('server');
      if (serverChild) {
        updateDevFlowSupervisorProcess('server', {
          status: 'stopped',
          pid: undefined,
          nextRetryAt: undefined,
          message: 'DevFlow server stopped during intentional supervisor shutdown.',
        });
        stopManagedProcessTree(serverChild);
      }

      await ownership.release();
      process.exit(0);
    })().catch(async (error) => {
      console.error(`[start-all] Shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
      try { await ownership.release(); } catch {}
      process.exit(1);
    });
    return shutdownPromise;
  };

  shutdownHandler = () => { void shutdown(); };
  if (shutdownRequested) void shutdown();
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
  return { reused: false, owner: ownership.owner };
}

const entryPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const currentPath = fileURLToPath(import.meta.url);
if (entryPath === currentPath) {
  const mode: StartAllMode = process.argv.slice(2).includes('--server-only') ? 'server-only' : 'all';
  startAll(mode).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[start-all] ${message}`);
    process.exitCode = typeof (error as any)?.exitCode === 'number' ? (error as any).exitCode : 1;
  });
}
