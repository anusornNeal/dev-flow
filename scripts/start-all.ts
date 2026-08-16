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
} from '../src/lib/devFlowRuntimeOwnership';
import {
  advanceDevFlowTunnelHealth,
  createDevFlowSupervisorState,
  resetDevFlowTunnelHealthForGeneration,
  readDevFlowSupervisorState,
  updateDevFlowSupervisorProcess,
  updateDevFlowSupervisorState,
  updateDevFlowSupervisorTunnelHealth,
  writeDevFlowSupervisorState,
  type DevFlowSupervisorProcessLabel,
  type DevFlowTunnelHealthState,
} from '../src/lib/devFlowSupervisor';

type StartAllOptions = {
  port: number;
  zrokPublicUrl: string;
  zrokReservedName: string;
  openBrowser: boolean;
  openBrowserDelayMs: number;
  zrokProbeIntervalMs: number;
  zrokProbeTimeoutMs: number;
  zrokProbeStartupGraceMs: number;
  zrokProbeFailureThreshold: number;
  zrokRecoveryCooldownMs: number;
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

type ZrokBootstrapResult = {
  ready: boolean;
  publicUrl: string;
  message: string;
};

type PublicProbeResult = {
  ok: boolean;
  statusCode?: number;
  latencyMs: number;
  message: string;
  failureClass?: ReturnType<typeof classifyPublicProbeFailure> | 'public-url-unavailable';
};

const DEFAULT_PORT = 3000;
const DEFAULT_BROWSER_DELAY_MS = 4000;
const DEFAULT_ZROK_PROBE_INTERVAL_MS = 15000;
const DEFAULT_ZROK_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_ZROK_PROBE_STARTUP_GRACE_MS = 30000;
const MAX_ZROK_PROBE_STARTUP_GRACE_MS = 120000;
const DEFAULT_ZROK_PROBE_FAILURE_THRESHOLD = 3;
const DEFAULT_ZROK_RECOVERY_COOLDOWN_MS = 15000;

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

export function normalizeZrokPublicUrl(input: { publicUrl?: string; reservedName?: string }) {
  const publicUrl = String(input.publicUrl || '').trim();
  if (publicUrl) {
    const candidate = /^https?:\/\//i.test(publicUrl) ? publicUrl : `https://${publicUrl}`;
    try {
      const parsed = new URL(candidate);
      return parsed.origin;
    } catch {
      return '';
    }
  }

  const reservedName = String(input.reservedName || '').trim();
  if (!reservedName) return '';
  const host = reservedName.includes('.') ? reservedName : `${reservedName}.shares.zrok.io`;
  try {
    return new URL(`https://${host}`).origin;
  } catch {
    return '';
  }
}

export function resolveStartAllOptions(env: NodeJS.ProcessEnv = process.env): StartAllOptions {
  return {
    port: parsePositiveInteger(env.DEVFLOW_PORT || env.PORT, DEFAULT_PORT),
    zrokPublicUrl: normalizeZrokPublicUrl({
      publicUrl: env.DEVFLOW_ZROK_PUBLIC_URL || env.DEVFLOW_PUBLIC_URL,
      reservedName: env.DEVFLOW_ZROK_RESERVED_NAME,
    }),
    zrokReservedName: String(env.DEVFLOW_ZROK_RESERVED_NAME || '').trim(),
    openBrowser: parseBoolean(env.DEVFLOW_OPEN_BROWSER, true),
    openBrowserDelayMs: parsePositiveInteger(env.DEVFLOW_OPEN_BROWSER_DELAY_MS, DEFAULT_BROWSER_DELAY_MS),
    zrokProbeIntervalMs: parsePositiveInteger(env.DEVFLOW_ZROK_PROBE_INTERVAL_MS, DEFAULT_ZROK_PROBE_INTERVAL_MS),
    zrokProbeTimeoutMs: parsePositiveInteger(env.DEVFLOW_ZROK_PROBE_TIMEOUT_MS, DEFAULT_ZROK_PROBE_TIMEOUT_MS),
    zrokProbeStartupGraceMs: Math.min(
      parsePositiveInteger(env.DEVFLOW_ZROK_PROBE_STARTUP_GRACE_MS, DEFAULT_ZROK_PROBE_STARTUP_GRACE_MS),
      MAX_ZROK_PROBE_STARTUP_GRACE_MS,
    ),
    zrokProbeFailureThreshold: parsePositiveInteger(env.DEVFLOW_ZROK_PROBE_FAILURE_THRESHOLD, DEFAULT_ZROK_PROBE_FAILURE_THRESHOLD),
    zrokRecoveryCooldownMs: parsePositiveInteger(env.DEVFLOW_ZROK_RECOVERY_COOLDOWN_MS, DEFAULT_ZROK_RECOVERY_COOLDOWN_MS),
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

export function buildZrokBootstrapInvocation(rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const scriptPath = path.join(rootDir, 'scripts', 'zrok-bootstrap.ps1');
  return {
    command: process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
    args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
    scriptPath,
  };
}

export function parseZrokBootstrapResult(output: string, fallbackPublicUrl = ''): ZrokBootstrapResult {
  const lines = String(output || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const payload = JSON.parse(lines[index]) as Record<string, unknown>;
      const status = String(payload.status || payload.state || '').trim().toLowerCase();
      const ready = typeof payload.ready === 'boolean'
        ? payload.ready
        : ['ready', 'running', 'healthy', 'ok', 'success'].includes(status);
      const publicUrl = normalizeZrokPublicUrl({
        publicUrl: String(payload.publicUrl || payload.shareUrl || payload.url || payload.endpoint || fallbackPublicUrl || ''),
        reservedName: String(payload.reservedName || payload.shareName || payload.name || ''),
      });
      return {
        ready,
        publicUrl,
        message: String(payload.message || payload.summary || (ready ? 'zrok bootstrap is ready.' : 'zrok bootstrap did not report ready state.')),
      };
    } catch {
      // Bootstrap may emit human-readable progress before the final structured record.
    }
  }

  return {
    ready: false,
    publicUrl: normalizeZrokPublicUrl({ publicUrl: fallbackPublicUrl }),
    message: 'zrok bootstrap did not emit a structured readiness result.',
  };
}

export function runZrokBootstrap(options: Pick<StartAllOptions, 'zrokPublicUrl'>, rootDir?: string): ZrokBootstrapResult {
  const invocation = buildZrokBootstrapInvocation(rootDir);
  if (!fs.existsSync(invocation.scriptPath)) {
    return {
      ready: false,
      publicUrl: options.zrokPublicUrl,
      message: `zrok bootstrap script is missing: ${invocation.scriptPath}`,
    };
  }

  const result = spawnSync(invocation.command, invocation.args, {
    env: process.env,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    windowsHide: false,
  });
  const parsed = parseZrokBootstrapResult(result.stdout || '', options.zrokPublicUrl);
  if (result.status === 0) return parsed;

  const stderr = String(result.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0];
  return {
    ready: false,
    publicUrl: parsed.publicUrl || options.zrokPublicUrl,
    message: stderr || parsed.message || `zrok bootstrap failed with exit code ${result.status ?? 1}.`,
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

export function classifyPublicProbeFailure(input: { statusCode?: number; error?: unknown }) {
  const statusCode = Number.isInteger(input.statusCode) ? Number(input.statusCode) : undefined;
  if (statusCode === 429) return 'rate-limit' as const;
  if (statusCode && statusCode >= 500) return 'http-5xx' as const;
  if (statusCode && statusCode >= 400) return 'http-4xx' as const;
  if (statusCode) return 'http-other' as const;
  const error = input.error as { name?: unknown; code?: unknown; message?: unknown } | undefined;
  const text = `${String(error?.name || '')} ${String(error?.code || '')} ${String(error?.message || input.error || '')}`.toLowerCase();
  if (/abort|timeout|timed out/.test(text)) return 'timeout' as const;
  if (/enotfound|getaddrinfo|dns/.test(text)) return 'dns' as const;
  if (/tls|ssl|certificate|cert_/.test(text)) return 'tls' as const;
  if (/econnrefused|econnreset|socket|connection|fetch failed/.test(text)) return 'connection' as const;
  return 'network' as const;
}

export function getZrokRecoveryDecision(input: {
  tunnelStatus: string;
  consecutiveProbeFailures: number;
  failureThreshold: number;
  localApiHealthy: boolean;
  shuttingDown: boolean;
  startupGraceUntilMs?: number;
  lifecyclePhase?: DevFlowTunnelHealthState['lifecyclePhase'];
  recoveryCooldownUntilMs?: number;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  if (input.shuttingDown) return 'suppressed-shutdown' as const;
  if (input.tunnelStatus !== 'down' || input.consecutiveProbeFailures < Math.max(1, input.failureThreshold)) return 'threshold-not-reached' as const;
  if (!input.localApiHealthy) return 'suppressed-local-api-unhealthy' as const;
  if (input.lifecyclePhase !== 'steady-state' && input.startupGraceUntilMs && input.startupGraceUntilMs > nowMs) return 'suppressed-startup-grace' as const;
  if (input.recoveryCooldownUntilMs && input.recoveryCooldownUntilMs > nowMs) return 'suppressed-recovery-cooldown' as const;
  return 'reconcile-zrok' as const;
}

export function shouldRecoverZrokTunnel(input: Parameters<typeof getZrokRecoveryDecision>[0]) {
  return getZrokRecoveryDecision(input) === 'reconcile-zrok';
}

export function apiCapabilitiesUrl(baseUrl: string) {
  return new URL('/api/capabilities', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function probeHttpEndpoint(url: string, timeoutMs: number, requireSuccessStatus: boolean): Promise<PublicProbeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  timer.unref();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    const ok = requireSuccessStatus ? response.ok : response.status >= 200 && response.status < 500;
    return {
      ok,
      statusCode: response.status,
      latencyMs: Date.now() - startedAt,
      message: `HTTP ${response.status}`,
      ...(ok ? {} : { failureClass: classifyPublicProbeFailure({ statusCode: response.status }) }),
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : String(error),
      failureClass: classifyPublicProbeFailure({ error }),
    };
  } finally {
    clearTimeout(timer);
  }
}

type ProcessCallbacks = {
  onExit?: (child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (child: ChildProcessWithoutNullStreams, error: Error) => void;
};

function startProcess(processConfig: ManagedProcess, callbacks: ProcessCallbacks = {}): ChildProcessWithoutNullStreams {
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
    if (mode === 'all' && options.openBrowser) openUrl(ownership.owner.appUrl);
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
  let tunnelProbeTimer: NodeJS.Timeout | null = null;
  let tunnelProbeInFlight = false;
  let zrokRecoveryTimer: NodeJS.Timeout | null = null;
  let zrokGeneration = 0;
  let recoveryCooldownUntilMs = 0;
  let activePublicUrl = options.zrokPublicUrl;
  let shuttingDown = false;

  writeDevFlowSupervisorState(createDevFlowSupervisorState({
    mode,
    processLabels: mode === 'all' ? ['server', 'zrok'] : ['server'],
  }));

  const currentTunnelHealth = (): DevFlowTunnelHealthState => readDevFlowSupervisorState()?.tunnelHealth || {
    status: 'unknown',
    consecutiveProbeFailures: 0,
  };

  const scheduleTunnelProbe = (delayMs = options.zrokProbeIntervalMs) => {
    if (mode !== 'all' || shuttingDown) return;
    if (tunnelProbeTimer) clearTimeout(tunnelProbeTimer);
    tunnelProbeTimer = setTimeout(() => {
      tunnelProbeTimer = null;
      void runTunnelProbe();
    }, Math.max(250, delayMs));
    tunnelProbeTimer.unref();
  };

  const scheduleZrokReconcile = (delayMs: number, reason: string) => {
    if (mode !== 'all' || shuttingDown || zrokRecoveryTimer) return;
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    updateDevFlowSupervisorProcess('zrok', {
      status: 'restarting',
      restartAttempt: Math.max(0, readDevFlowSupervisorState()?.processes.zrok?.restartAttempt || 0) + 1,
      nextRetryAt,
      message: reason,
    });
    zrokRecoveryTimer = setTimeout(() => {
      zrokRecoveryTimer = null;
      if (!shuttingDown) reconcileZrok(reason);
    }, Math.max(250, delayMs));
    zrokRecoveryTimer.unref();
  };

  const reconcileZrok = (reason: string) => {
    if (mode !== 'all' || shuttingDown) return;
    zrokGeneration += 1;
    updateDevFlowSupervisorTunnelHealth(resetDevFlowTunnelHealthForGeneration(
      currentTunnelHealth(),
      String(zrokGeneration),
      { startupGraceMs: options.zrokProbeStartupGraceMs },
    ));
    updateDevFlowSupervisorProcess('zrok', {
      status: reason === 'startup' ? 'starting' : 'restarting',
      nextRetryAt: undefined,
      message: `Reconciling zrok service/share: ${reason}`,
    });

    const result = runZrokBootstrap(options);
    if (result.publicUrl) activePublicUrl = result.publicUrl;
    if (result.ready) {
      updateDevFlowSupervisorProcess('zrok', {
        status: 'running',
        startedAt: new Date().toISOString(),
        restartAttempt: 0,
        nextRetryAt: undefined,
        message: activePublicUrl
          ? `zrok service/share is ready at ${activePublicUrl}.`
          : 'zrok service/share is ready; waiting for a public endpoint.',
      });
      recoveryCooldownUntilMs = 0;
      scheduleTunnelProbe(250);
      return;
    }

    recoveryCooldownUntilMs = Date.now() + options.zrokRecoveryCooldownMs;
    updateDevFlowSupervisorProcess('zrok', {
      status: 'failed',
      nextRetryAt: new Date(recoveryCooldownUntilMs).toISOString(),
      message: result.message,
    });
    updateDevFlowSupervisorTunnelHealth({
      ...currentTunnelHealth(),
      status: 'down',
      lastFailureAt: new Date().toISOString(),
      consecutiveProbeFailures: Math.max(options.zrokProbeFailureThreshold, currentTunnelHealth().consecutiveProbeFailures),
      nextRecoveryAt: new Date(recoveryCooldownUntilMs).toISOString(),
      message: `zrok service/share is not ready: ${result.message}`,
    });
    scheduleZrokReconcile(options.zrokRecoveryCooldownMs, 'bootstrap/service readiness recovery');
  };

  async function runTunnelProbe() {
    if (mode !== 'all' || shuttingDown || tunnelProbeInFlight) return;
    tunnelProbeInFlight = true;
    const probeGeneration = currentTunnelHealth().generation;
    try {
      const publicProbe: PublicProbeResult = activePublicUrl
        ? await probeHttpEndpoint(apiCapabilitiesUrl(activePublicUrl), options.zrokProbeTimeoutMs, true)
        : {
            ok: false,
            latencyMs: 0,
            message: 'zrok public URL is unavailable from bootstrap/configuration.',
            failureClass: 'public-url-unavailable',
          };

      let next = advanceDevFlowTunnelHealth(currentTunnelHealth(), publicProbe, {
        failureThreshold: options.zrokProbeFailureThreshold,
        generation: probeGeneration,
      });
      if (probeGeneration && next.generation !== probeGeneration) return;
      updateDevFlowSupervisorTunnelHealth(next);
      if (next.status !== 'down') return;

      const localProbe = await probeHttpEndpoint(apiCapabilitiesUrl(plan.appUrl), options.zrokProbeTimeoutMs, true);
      const decision = getZrokRecoveryDecision({
        tunnelStatus: next.status,
        consecutiveProbeFailures: next.consecutiveProbeFailures,
        failureThreshold: options.zrokProbeFailureThreshold,
        localApiHealthy: localProbe.ok,
        shuttingDown,
        startupGraceUntilMs: next.startupGraceUntil ? Date.parse(next.startupGraceUntil) : undefined,
        lifecyclePhase: next.lifecyclePhase,
        recoveryCooldownUntilMs,
      });

      if (decision === 'reconcile-zrok') {
        recoveryCooldownUntilMs = Date.now() + options.zrokRecoveryCooldownMs;
        next = {
          ...next,
          recoveryAttempt: Math.max(0, next.recoveryAttempt || 0) + 1,
          lastRecoveryAt: new Date().toISOString(),
          nextRecoveryAt: new Date(recoveryCooldownUntilMs).toISOString(),
          message: 'Public zrok tunnel is down while local API is healthy; reconciling zrok service/share only.',
        };
        updateDevFlowSupervisorTunnelHealth(next);
        scheduleZrokReconcile(250, 'public tunnel recovery');
      } else if (!localProbe.ok) {
        updateDevFlowSupervisorTunnelHealth({
          ...next,
          message: 'Public tunnel is down, but local DevFlow API is also unhealthy; zrok reconciliation is suppressed.',
        });
      }
    } finally {
      tunnelProbeInFlight = false;
      scheduleTunnelProbe();
    }
  }

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
            message: `Restart ticket ${restartState!.ticket} accepted; relaunching DevFlow server.`,
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
      message: child.pid ? 'server child process is running.' : 'server child process is starting.',
    });
    if (child.pid) lifecycleStatus = 'running';
    return child;
  };

  launchServer();
  if (mode === 'all') reconcileZrok('startup');

  if (plan.openBrowser) setTimeout(() => openUrl(plan.appUrl), plan.openBrowserDelayMs);

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleStatus = 'stopping';
    updateDevFlowSupervisorState({ shuttingDown: true });
    if (tunnelProbeTimer) clearTimeout(tunnelProbeTimer);
    if (zrokRecoveryTimer) clearTimeout(zrokRecoveryTimer);
    tunnelProbeTimer = null;
    zrokRecoveryTimer = null;
    const serverChild = children.get('server');
    if (serverChild) {
      updateDevFlowSupervisorProcess('server', {
        status: 'stopped',
        pid: undefined,
        nextRetryAt: undefined,
        message: 'server stopped during intentional supervisor shutdown.',
      });
      stopManagedProcessTree(serverChild);
    }
    if (mode === 'all') {
      updateDevFlowSupervisorProcess('zrok', {
        nextRetryAt: undefined,
        message: 'Supervisor stopped monitoring zrok; persistent agent service/share is left running.',
      });
    }
    void ownership.release().finally(() => process.exit(0));
  };

  shutdownHandler = shutdown;
  if (shutdownRequested) shutdown();
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
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
