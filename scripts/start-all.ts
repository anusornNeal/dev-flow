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
import { getDevFlowRuntimeDir } from '../src/lib/devFlowPaths';
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
  ngrokDomain: string;
  openBrowser: boolean;
  openBrowserDelayMs: number;
  ngrokRestartBaseMs: number;
  ngrokRestartMaxMs: number;
  ngrokStableResetMs: number;
  ngrokProbeIntervalMs: number;
  ngrokProbeTimeoutMs: number;
  ngrokProbeStartupGraceMs: number;
  ngrokProbeFailureThreshold: number;
  ngrokCollisionBackoffMs: number;
  ngrokLogMaxBytes: number;
};

type ManagedProcess = {
  label: DevFlowSupervisorProcessLabel;
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
const DEFAULT_NGROK_RESTART_BASE_MS = 1000;
const DEFAULT_NGROK_RESTART_MAX_MS = 30000;
const DEFAULT_NGROK_STABLE_RESET_MS = 60000;
const DEFAULT_NGROK_PROBE_INTERVAL_MS = 15000;
const DEFAULT_NGROK_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_NGROK_PROBE_STARTUP_GRACE_MS = 5000;
const DEFAULT_NGROK_PROBE_FAILURE_THRESHOLD = 3;
const DEFAULT_NGROK_COLLISION_BACKOFF_MS = 30000;
const DEFAULT_NGROK_LOG_MAX_BYTES = 128 * 1024;

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

function buildNgrokInvocation(args: string[]) {
  if (process.platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'ngrok', ...args] };
  }

  return { command: 'ngrok', args };
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

export function buildNgrokArgs({ port, domain }: { port: number; domain: string }) {
  const args = ['http'];
  if (domain.trim()) {
    args.push(`--domain=${domain.trim()}`);
  }
  args.push(String(port));
  return args;
}

export function resolveStartAllOptions(env: NodeJS.ProcessEnv = process.env): StartAllOptions {
  const ngrokRestartBaseMs = parsePositiveInteger(env.DEVFLOW_NGROK_RESTART_BASE_MS, DEFAULT_NGROK_RESTART_BASE_MS);
  const ngrokRestartMaxMs = Math.max(
    ngrokRestartBaseMs,
    parsePositiveInteger(env.DEVFLOW_NGROK_RESTART_MAX_MS, DEFAULT_NGROK_RESTART_MAX_MS),
  );
  return {
    port: parsePositiveInteger(env.DEVFLOW_PORT || env.PORT, DEFAULT_PORT),
    ngrokDomain: (env.DEVFLOW_NGROK_DOMAIN || '').trim(),
    openBrowser: parseBoolean(env.DEVFLOW_OPEN_BROWSER, true),
    openBrowserDelayMs: parsePositiveInteger(env.DEVFLOW_OPEN_BROWSER_DELAY_MS, DEFAULT_BROWSER_DELAY_MS),
    ngrokRestartBaseMs,
    ngrokRestartMaxMs,
    ngrokStableResetMs: parsePositiveInteger(env.DEVFLOW_NGROK_STABLE_RESET_MS, DEFAULT_NGROK_STABLE_RESET_MS),
    ngrokProbeIntervalMs: parsePositiveInteger(env.DEVFLOW_NGROK_PROBE_INTERVAL_MS, DEFAULT_NGROK_PROBE_INTERVAL_MS),
    ngrokProbeTimeoutMs: parsePositiveInteger(env.DEVFLOW_NGROK_PROBE_TIMEOUT_MS, DEFAULT_NGROK_PROBE_TIMEOUT_MS),
    ngrokProbeStartupGraceMs: parsePositiveInteger(env.DEVFLOW_NGROK_PROBE_STARTUP_GRACE_MS, DEFAULT_NGROK_PROBE_STARTUP_GRACE_MS),
    ngrokProbeFailureThreshold: parsePositiveInteger(env.DEVFLOW_NGROK_PROBE_FAILURE_THRESHOLD, DEFAULT_NGROK_PROBE_FAILURE_THRESHOLD),
    ngrokCollisionBackoffMs: parsePositiveInteger(env.DEVFLOW_NGROK_COLLISION_BACKOFF_MS, DEFAULT_NGROK_COLLISION_BACKOFF_MS),
    ngrokLogMaxBytes: parsePositiveInteger(env.DEVFLOW_NGROK_LOG_MAX_BYTES, DEFAULT_NGROK_LOG_MAX_BYTES),
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
  const ngrokInvocation = buildNgrokInvocation(buildNgrokArgs({ port: options.port, domain: options.ngrokDomain }));
  const ngrok: ManagedProcess = {
    label: 'ngrok',
    ...ngrokInvocation,
  };
  const processes: ManagedProcess[] = mode === 'all' ? [server, ngrok] : [server];

  return {
    mode,
    appUrl: `http://localhost:${options.port}`,
    openBrowser: mode === 'all' ? options.openBrowser : false,
    openBrowserDelayMs: options.openBrowserDelayMs,
    processes,
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
  const result = spawnSync(npmSetup.command, npmSetup.args, {
    stdio: 'inherit',
    env: process.env,
  });

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
    && Boolean(input.supervisorToken) && input.restartState.supervisorToken === input.supervisorToken;
}

export function shouldRestartManagedProcess(input: {
  label: string;
  mode: StartAllMode;
  shuttingDown: boolean;
}) {
  return !input.shuttingDown && input.mode === 'all' && input.label === 'ngrok';
}

export function computeManagedProcessRestartDelayMs(
  attempt: number,
  options: { baseMs: number; maxMs: number },
) {
  const normalizedAttempt = Math.max(1, Math.floor(attempt));
  const baseMs = Math.max(1, Math.floor(options.baseMs));
  const maxMs = Math.max(baseMs, Math.floor(options.maxMs));
  return Math.min(maxMs, baseMs * (2 ** Math.min(30, normalizedAttempt - 1)));
}

export function classifyNgrokDiagnosticLine(line: string): {
  errorCode?: string;
  classification: 'endpoint-session-collision' | 'ngrok-error' | 'unclassified';
} {
  const errorCode = String(line || '').match(/\bERR_NGROK_\d+\b/i)?.[0]?.toUpperCase();
  if (errorCode === 'ERR_NGROK_334') {
    return { errorCode, classification: 'endpoint-session-collision' as const };
  }
  if (errorCode) return { errorCode, classification: 'ngrok-error' as const };
  return { classification: 'unclassified' as const };
}

export function sanitizeNgrokDiagnosticLine(line: string) {
  return String(line || '')
    .replace(/https?:\/\/[^\s"']+/gi, '[url]')
    .replace(/\b(token|authtoken)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/\b(token|authtoken)\s+([^\s]+)/gi, '$1 [redacted]')
    .trim();
}

function appendBoundedNgrokDiagnosticRecord(filePath: string, record: Record<string, unknown>, maxBytes: number) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let lines: string[] = [];
  try {
    lines = fs.existsSync(filePath)
      ? fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean)
      : [];
  } catch {
    lines = [];
  }
  lines.push(JSON.stringify(record));
  const boundedMaxBytes = Math.max(512, Math.floor(maxBytes));
  while (lines.length > 0 && Buffer.byteLength(`${lines.join('\n')}\n`, 'utf8') > boundedMaxBytes) lines.shift();
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return record;
}

export function appendNgrokDiagnosticRecord(input: {
  filePath: string;
  stream: 'stdout' | 'stderr' | 'supervisor';
  line: string;
  maxBytes: number;
  now?: string;
}) {
  const message = sanitizeNgrokDiagnosticLine(input.line).slice(0, 2048);
  if (!message) return null;
  const classification = classifyNgrokDiagnosticLine(message);
  return appendBoundedNgrokDiagnosticRecord(input.filePath, {
    at: input.now || new Date().toISOString(),
    stream: input.stream,
    message,
    ...classification,
  }, input.maxBytes);
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

export function sanitizeRetryAfter(value: string | null | undefined) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return undefined;
  if (/^\d{1,9}$/.test(trimmed)) return trimmed;
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function safeDiagnosticGeneration(value: unknown) {
  const generation = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(generation) ? generation : undefined;
}

function safeDiagnosticNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

export function extractNgrokPressureSnapshot(payload: unknown) {
  const tunnels = Array.isArray((payload as any)?.tunnels) ? (payload as any).tunnels : [];
  const snapshot = {
    connectionCount: 0,
    activeConnections: 0,
    connectionRate1: 0,
    requestCount: 0,
    requestRate1: 0,
  };
  let observed = false;
  for (const tunnel of tunnels) {
    const conns = tunnel?.metrics?.conns || {};
    const http = tunnel?.metrics?.http || {};
    for (const [source, key] of [
      [conns, 'count'], [conns, 'gauge'], [conns, 'rate1'], [http, 'count'], [http, 'rate1'],
    ] as const) {
      if (safeDiagnosticNumber(source?.[key]) !== undefined) observed = true;
    }
    snapshot.connectionCount += safeDiagnosticNumber(conns.count) || 0;
    snapshot.activeConnections += safeDiagnosticNumber(conns.gauge) || 0;
    snapshot.connectionRate1 += safeDiagnosticNumber(conns.rate1) || 0;
    snapshot.requestCount += safeDiagnosticNumber(http.count) || 0;
    snapshot.requestRate1 += safeDiagnosticNumber(http.rate1) || 0;
  }
  return observed ? snapshot : undefined;
}

export async function sampleNgrokInspectorPressure(timeoutMs: number, fetchImpl: typeof fetch = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(500, timeoutMs)));
  timer.unref();
  try {
    const response = await fetchImpl('http://127.0.0.1:4040/api/tunnels', { signal: controller.signal });
    if (!response.ok) return undefined;
    return extractNgrokPressureSnapshot(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export function appendNgrokProbeDiagnosticRecord(input: {
  filePath: string;
  failureClass: string;
  statusCode?: number;
  latencyMs?: number;
  generation?: string;
  consecutiveProbeFailures: number;
  recoveryDecision: string;
  retryAfter?: string;
  maxBytes: number;
  now?: string;
}) {
  const allowedFailureClasses = new Set(['rate-limit', 'http-5xx', 'http-4xx', 'http-other', 'timeout', 'dns', 'tls', 'connection', 'network', 'public-url-unavailable']);
  const allowedRecoveryDecisions = new Set(['threshold-not-reached', 'restart-ngrok', 'suppressed-shutdown', 'suppressed-local-api-unhealthy', 'suppressed-ngrok-not-running', 'suppressed-startup-grace', 'suppressed-collision-backoff']);
  const failureClass = allowedFailureClasses.has(input.failureClass) ? input.failureClass : 'network';
  const recoveryDecision = allowedRecoveryDecisions.has(input.recoveryDecision) ? input.recoveryDecision : 'threshold-not-reached';
  const retryAfter = sanitizeRetryAfter(input.retryAfter);
  const generation = safeDiagnosticGeneration(input.generation);
  return appendBoundedNgrokDiagnosticRecord(input.filePath, {
    at: input.now || new Date().toISOString(),
    kind: 'public-probe-failure',
    failureClass,
    ...(Number.isInteger(input.statusCode) ? { statusCode: input.statusCode } : {}),
    ...(safeDiagnosticNumber(input.latencyMs) !== undefined ? { latencyMs: safeDiagnosticNumber(input.latencyMs) } : {}),
    ...(generation ? { generation } : {}),
    consecutiveProbeFailures: Math.max(0, Math.floor(input.consecutiveProbeFailures || 0)),
    recoveryDecision,
    ...(retryAfter ? { retryAfter } : {}),
  }, input.maxBytes);
}

export function appendNgrokPressureDiagnosticRecord(input: {
  filePath: string;
  generation?: string;
  pressure: ReturnType<typeof extractNgrokPressureSnapshot>;
  maxBytes: number;
  now?: string;
}) {
  if (!input.pressure) return null;
  const generation = safeDiagnosticGeneration(input.generation);
  return appendBoundedNgrokDiagnosticRecord(input.filePath, {
    at: input.now || new Date().toISOString(),
    kind: 'ngrok-pressure',
    ...(generation ? { generation } : {}),
    pressure: input.pressure,
  }, input.maxBytes);
}

export function getNgrokRecoveryDecision(input: {
  tunnelStatus: string;
  consecutiveProbeFailures: number;
  failureThreshold: number;
  localApiHealthy: boolean;
  ngrokProcessRunning: boolean;
  shuttingDown: boolean;
  collisionBackoffUntilMs?: number;
  startupGraceUntilMs?: number;
  nowMs?: number;
}) {
  const nowMs = input.nowMs ?? Date.now();
  if (input.shuttingDown) return 'suppressed-shutdown' as const;
  if (input.tunnelStatus !== 'down' || input.consecutiveProbeFailures < Math.max(1, input.failureThreshold)) return 'threshold-not-reached' as const;
  if (!input.localApiHealthy) return 'suppressed-local-api-unhealthy' as const;
  if (!input.ngrokProcessRunning) return 'suppressed-ngrok-not-running' as const;
  if (input.startupGraceUntilMs && input.startupGraceUntilMs > nowMs) return 'suppressed-startup-grace' as const;
  if (input.collisionBackoffUntilMs && input.collisionBackoffUntilMs > nowMs) return 'suppressed-collision-backoff' as const;
  return 'restart-ngrok' as const;
}

export function shouldRecoverNgrokTunnel(input: Parameters<typeof getNgrokRecoveryDecision>[0]) {
  return getNgrokRecoveryDecision(input) === 'restart-ngrok';
}

async function probeHttpEndpoint(url: string, timeoutMs: number, requireSuccessStatus: boolean) {
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
      ...(response.status === 429 ? { retryAfter: sanitizeRetryAfter(response.headers.get('retry-after')) } : {}),
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

async function discoverNgrokPublicUrl(domain: string, timeoutMs: number) {
  if (domain.trim()) return `https://${domain.trim()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));
  timer.unref();
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json() as { tunnels?: Array<{ public_url?: string }> };
    const publicUrl = payload.tunnels?.map((entry) => String(entry.public_url || '')).find((value) => /^https?:\/\//i.test(value));
    return publicUrl || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function apiCapabilitiesUrl(baseUrl: string) {
  return new URL('/api/capabilities', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

type ProcessCallbacks = {
  onStdout?: (child: ChildProcessWithoutNullStreams, text: string) => void;
  onStderr?: (child: ChildProcessWithoutNullStreams, text: string) => void;
  onExit?: (child: ChildProcessWithoutNullStreams, code: number | null, signal: NodeJS.Signals | null) => void;
  onError?: (child: ChildProcessWithoutNullStreams, error: Error) => void;
};

function startProcess(processConfig: ManagedProcess, callbacks: ProcessCallbacks = {}): ChildProcessWithoutNullStreams {
  console.log(`[start-all] Starting ${processConfig.label}: ${processConfig.command} ${processConfig.args.join(' ')}`);
  const child = spawn(processConfig.command, processConfig.args, {
    env: { ...process.env, ...(processConfig.env || {}) },
    shell: false,
  });

  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    const rendered = processConfig.label === 'ngrok' ? sanitizeNgrokDiagnosticLine(text) : text;
    process.stdout.write(`[${processConfig.label}] ${rendered}${rendered.endsWith('\n') ? '' : '\n'}`);
    callbacks.onStdout?.(child, text);
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    const rendered = processConfig.label === 'ngrok' ? sanitizeNgrokDiagnosticLine(text) : text;
    process.stderr.write(`[${processConfig.label}] ${rendered}${rendered.endsWith('\n') ? '' : '\n'}`);
    callbacks.onStderr?.(child, text);
  });

  child.on('exit', (code, signal) => {
    const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
    console.log(`[start-all] ${processConfig.label} exited with ${detail}`);
    callbacks.onExit?.(child, code, signal);
  });

  child.on('error', (error) => {
    console.error(`[start-all] Failed to start ${processConfig.label}: ${error.message}`);
    callbacks.onError?.(child, error);
  });

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
  const restartTimers = new Map<DevFlowSupervisorProcessLabel, NodeJS.Timeout>();
  const stableTimers = new Map<DevFlowSupervisorProcessLabel, NodeJS.Timeout>();
  const restartAttempts = new Map<DevFlowSupervisorProcessLabel, number>();
  let tunnelProbeTimer: NodeJS.Timeout | null = null;
  let tunnelProbeInFlight = false;
  let collisionBackoffUntilMs = 0;
  let recoveryStopChild: ChildProcessWithoutNullStreams | null = null;
  let ngrokGeneration = 0;
  const ngrokDiagnosticLogPath = path.join(getDevFlowRuntimeDir(), 'ngrok-diagnostics.jsonl');

  const currentTunnelHealth = (): DevFlowTunnelHealthState => readDevFlowSupervisorState()?.tunnelHealth || {
    status: 'unknown',
    consecutiveProbeFailures: 0,
  };

  const captureNgrokDiagnostic = (stream: 'stdout' | 'stderr' | 'supervisor', raw: string) => {
    for (const line of String(raw || '').split(/\r?\n/).filter((entry) => entry.trim())) {
      const record = appendNgrokDiagnosticRecord({
        filePath: ngrokDiagnosticLogPath,
        stream,
        line,
        maxBytes: options.ngrokLogMaxBytes,
      });
      if (!record?.errorCode) continue;
      const collision = record.errorCode === 'ERR_NGROK_334';
      if (collision) {
        collisionBackoffUntilMs = Math.max(collisionBackoffUntilMs, Date.now() + options.ngrokCollisionBackoffMs);
      }
      updateDevFlowSupervisorTunnelHealth({
        ...currentTunnelHealth(),
        lastErrorCode: record.errorCode,
        lastErrorClass: record.classification,
        ...(collision ? { nextRecoveryAt: new Date(collisionBackoffUntilMs).toISOString() } : {}),
        message: collision
          ? 'ngrok endpoint/session collision detected; recovery is paused for bounded backoff.'
          : `ngrok reported ${record.errorCode}; see bounded diagnostics for the redacted event.`,
      });
    }
  };

  let shuttingDown = false;

  writeDevFlowSupervisorState(createDevFlowSupervisorState({
    mode,
    processLabels: plan.processes.map((entry) => entry.label),
  }));

  const clearTimer = (timers: Map<DevFlowSupervisorProcessLabel, NodeJS.Timeout>, label: DevFlowSupervisorProcessLabel) => {
    const timer = timers.get(label);
    if (timer) clearTimeout(timer);
    timers.delete(label);
  };

  let launch: (processConfig: ManagedProcess) => ChildProcessWithoutNullStreams;

  const scheduleManagedRestart = (
    processConfig: ManagedProcess,
    detail: { code?: number | null; signal?: NodeJS.Signals | null; message: string },
  ) => {
    if (!shouldRestartManagedProcess({ label: processConfig.label, mode, shuttingDown })) return false;
    if (restartTimers.has(processConfig.label)) return true;

    const attempt = (restartAttempts.get(processConfig.label) || 0) + 1;
    restartAttempts.set(processConfig.label, attempt);
    const baseDelayMs = computeManagedProcessRestartDelayMs(attempt, {
      baseMs: options.ngrokRestartBaseMs,
      maxMs: options.ngrokRestartMaxMs,
    });
    const collisionDelayMs = processConfig.label === 'ngrok'
      ? Math.max(0, collisionBackoffUntilMs - Date.now())
      : 0;
    const delayMs = Math.max(baseDelayMs, collisionDelayMs);
    const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
    updateDevFlowSupervisorProcess(processConfig.label, {
      status: 'restarting',
      pid: undefined,
      restartAttempt: attempt,
      nextRetryAt,
      ...('code' in detail ? { lastExitCode: detail.code } : {}),
      ...('signal' in detail ? { lastSignal: detail.signal || null } : {}),
      lastExitAt: new Date().toISOString(),
      message: detail.message,
    });
    console.warn(`[start-all] ${processConfig.label} restart scheduled attempt=${attempt} delayMs=${delayMs}: ${detail.message}`);

    const timer = setTimeout(() => {
      restartTimers.delete(processConfig.label);
      if (shuttingDown) return;
      launch(processConfig);
    }, delayMs);
    restartTimers.set(processConfig.label, timer);
    return true;
  };

  launch = (processConfig: ManagedProcess): ChildProcessWithoutNullStreams => {
    clearTimer(stableTimers, processConfig.label);
    if (processConfig.label === 'ngrok') {
      ngrokGeneration += 1;
      updateDevFlowSupervisorTunnelHealth(resetDevFlowTunnelHealthForGeneration(
        currentTunnelHealth(),
        String(ngrokGeneration),
        { startupGraceMs: options.ngrokProbeStartupGraceMs },
      ));
    }
    const child = startProcess(processConfig, {
      onStdout: (_runningChild, text) => {
        if (processConfig.label === 'ngrok') captureNgrokDiagnostic('stdout', text);
      },
      onStderr: (_runningChild, text) => {
        if (processConfig.label === 'ngrok') captureNgrokDiagnostic('stderr', text);
      },
      onExit: (exitedChild, code, signal) => {
        if (children.get(processConfig.label) !== exitedChild) return;
        children.delete(processConfig.label);
        clearTimer(stableTimers, processConfig.label);
        const detail = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;

        if (processConfig.label === 'ngrok') {
          const recoveryExit = recoveryStopChild === exitedChild;
          if (recoveryExit) recoveryStopChild = null;
          const exitMessage = recoveryExit
            ? `ngrok stopped for public tunnel recovery with ${detail}.`
            : `ngrok exited unexpectedly with ${detail}.`;
          captureNgrokDiagnostic('supervisor', exitMessage);
          if (scheduleManagedRestart(processConfig, {
            code,
            signal,
            message: exitMessage,
          })) return;
          updateDevFlowSupervisorProcess('ngrok', {
            status: shuttingDown ? 'stopped' : 'failed',
            pid: undefined,
            lastExitAt: new Date().toISOString(),
            lastExitCode: code,
            lastSignal: signal,
            nextRetryAt: undefined,
            message: shuttingDown ? 'ngrok stopped during intentional supervisor shutdown.' : `ngrok exited with ${detail}.`,
          });
          return;
        }

        const restartState = readDevFlowRestartState();
        const supervisorToken = processConfig.env?.[DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV];
        if (shouldRestartServerProcess({
          label: processConfig.label,
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
          console.log(`[start-all] Restart ticket ${restartState!.ticket} accepted; relaunching DevFlow server.`);
          try {
            const replacement = launch(processConfig);
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

        if (
          !shuttingDown
          && restartState?.status === 'accepted'
          && restartState.supervisorToken === supervisorToken
        ) {
          markDevFlowRestartFailed(restartState.ticket, `DevFlow exited with ${detail} before restart handoff completed.`);
          return;
        }

        if (
          !shuttingDown
          && restartState?.status === 'restarting'
          && restartState.replacementPid === exitedChild.pid
        ) {
          markDevFlowRestartFailed(restartState.ticket, `Replacement DevFlow server exited with ${detail} before becoming healthy.`);
        }
      },
      onError: (failedChild, error) => {
        if (children.get(processConfig.label) !== failedChild) return;
        children.delete(processConfig.label);
        clearTimer(stableTimers, processConfig.label);

        if (processConfig.label === 'ngrok') {
          captureNgrokDiagnostic('supervisor', `ngrok failed to start: ${error.message}`);
          if (scheduleManagedRestart(processConfig, { message: `ngrok failed to start: ${error.message}` })) return;
          updateDevFlowSupervisorProcess('ngrok', {
            status: shuttingDown ? 'stopped' : 'failed',
            pid: undefined,
            message: error.message,
          });
          return;
        }

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

    children.set(processConfig.label, child);
    updateDevFlowSupervisorProcess(processConfig.label, {
      status: child.pid ? 'running' : 'starting',
      ...(child.pid ? { pid: child.pid } : { pid: undefined }),
      startedAt: new Date().toISOString(),
      restartAttempt: restartAttempts.get(processConfig.label) || 0,
      nextRetryAt: undefined,
      message: child.pid ? `${processConfig.label} child process is running.` : `${processConfig.label} child process is starting.`,
    });

    if (processConfig.label === 'server' && child.pid) lifecycleStatus = 'running';

    if (processConfig.label === 'ngrok') {
      const stableChild = child;
      const timer = setTimeout(() => {
        stableTimers.delete('ngrok');
        if (shuttingDown || children.get('ngrok') !== stableChild) return;
        restartAttempts.set('ngrok', 0);
        updateDevFlowSupervisorProcess('ngrok', {
          status: 'running',
          restartAttempt: 0,
          nextRetryAt: undefined,
          message: 'ngrok child process is stable; restart backoff reset.',
        });
      }, options.ngrokStableResetMs);
      timer.unref();
      stableTimers.set('ngrok', timer);
    }

    return child;
  };

  function scheduleTunnelProbe(delayMs = options.ngrokProbeIntervalMs) {
    if (mode !== 'all' || shuttingDown) return;
    if (tunnelProbeTimer) clearTimeout(tunnelProbeTimer);
    tunnelProbeTimer = setTimeout(() => {
      tunnelProbeTimer = null;
      void runTunnelProbe();
    }, Math.max(250, delayMs));
    tunnelProbeTimer.unref();
  }

  async function runTunnelProbe() {
    if (mode !== 'all' || shuttingDown || tunnelProbeInFlight) return;
    const ngrokChild = children.get('ngrok');
    if (!ngrokChild?.pid || ngrokChild.exitCode !== null) {
      scheduleTunnelProbe();
      return;
    }

    tunnelProbeInFlight = true;
    const probeGeneration = currentTunnelHealth().generation;
    try {
      const publicBaseUrl = await discoverNgrokPublicUrl(options.ngrokDomain, options.ngrokProbeTimeoutMs);
      const publicProbe = publicBaseUrl
        ? await probeHttpEndpoint(apiCapabilitiesUrl(publicBaseUrl), options.ngrokProbeTimeoutMs, true)
        : { ok: false, statusCode: undefined, latencyMs: 0, message: 'ngrok public URL is unavailable from the configured domain or local inspector.', failureClass: 'public-url-unavailable' as const, retryAfter: undefined };
      let next = advanceDevFlowTunnelHealth(currentTunnelHealth(), publicProbe, {
        failureThreshold: options.ngrokProbeFailureThreshold,
        generation: probeGeneration,
      });
      if (probeGeneration && next.generation !== probeGeneration) return;
      updateDevFlowSupervisorTunnelHealth(next);

      if (!publicProbe.ok && next.status !== 'down') {
        const recoveryDecision = getNgrokRecoveryDecision({
          tunnelStatus: next.status,
          consecutiveProbeFailures: next.consecutiveProbeFailures,
          failureThreshold: options.ngrokProbeFailureThreshold,
          localApiHealthy: true,
          ngrokProcessRunning: children.get('ngrok') === ngrokChild && ngrokChild.exitCode === null,
          shuttingDown,
          startupGraceUntilMs: next.startupGraceUntil ? Date.parse(next.startupGraceUntil) : undefined,
          collisionBackoffUntilMs,
        });
        appendNgrokProbeDiagnosticRecord({
          filePath: ngrokDiagnosticLogPath,
          failureClass: publicProbe.failureClass || 'network',
          statusCode: publicProbe.statusCode,
          latencyMs: publicProbe.latencyMs,
          generation: next.generation,
          consecutiveProbeFailures: next.consecutiveProbeFailures,
          recoveryDecision,
          retryAfter: 'retryAfter' in publicProbe ? publicProbe.retryAfter : undefined,
          maxBytes: options.ngrokLogMaxBytes,
        });
        void sampleNgrokInspectorPressure(options.ngrokProbeTimeoutMs).then((pressure) => {
          appendNgrokPressureDiagnosticRecord({
            filePath: ngrokDiagnosticLogPath,
            generation: next.generation,
            pressure,
            maxBytes: options.ngrokLogMaxBytes,
          });
        });
        return;
      }
      if (next.status !== 'down') return;
      const localProbe = await probeHttpEndpoint(apiCapabilitiesUrl(plan.appUrl), options.ngrokProbeTimeoutMs, true);
      const recoveryDecision = getNgrokRecoveryDecision({
        tunnelStatus: next.status,
        consecutiveProbeFailures: next.consecutiveProbeFailures,
        failureThreshold: options.ngrokProbeFailureThreshold,
        localApiHealthy: localProbe.ok,
        ngrokProcessRunning: children.get('ngrok') === ngrokChild && ngrokChild.exitCode === null,
        shuttingDown,
        startupGraceUntilMs: next.startupGraceUntil ? Date.parse(next.startupGraceUntil) : undefined,
        collisionBackoffUntilMs,
      });
      if (!publicProbe.ok) {
        appendNgrokProbeDiagnosticRecord({
          filePath: ngrokDiagnosticLogPath,
          failureClass: publicProbe.failureClass || 'network',
          statusCode: publicProbe.statusCode,
          latencyMs: publicProbe.latencyMs,
          generation: next.generation,
          consecutiveProbeFailures: next.consecutiveProbeFailures,
          recoveryDecision,
          retryAfter: 'retryAfter' in publicProbe ? publicProbe.retryAfter : undefined,
          maxBytes: options.ngrokLogMaxBytes,
        });
        void sampleNgrokInspectorPressure(options.ngrokProbeTimeoutMs).then((pressure) => {
          appendNgrokPressureDiagnosticRecord({
            filePath: ngrokDiagnosticLogPath,
            generation: next.generation,
            pressure,
            maxBytes: options.ngrokLogMaxBytes,
          });
        });
      }
      const canRecover = recoveryDecision === 'restart-ngrok';

      if (canRecover && recoveryStopChild !== ngrokChild) {
        next = {
          ...next,
          recoveryAttempt: Math.max(0, next.recoveryAttempt || 0) + 1,
          lastRecoveryAt: new Date().toISOString(),
          nextRecoveryAt: undefined,
          message: 'Persistent public tunnel failure while local API is healthy; restarting ngrok only.',
        };
        updateDevFlowSupervisorTunnelHealth(next);
        captureNgrokDiagnostic('supervisor', next.message || 'ngrok-only recovery requested.');
        recoveryStopChild = ngrokChild;
        stopManagedProcessTree(ngrokChild);
      } else if (!localProbe.ok) {
        updateDevFlowSupervisorTunnelHealth({
          ...next,
          message: 'Public tunnel is down, but local DevFlow API is also unhealthy; ngrok-only recovery suppressed.',
        });
      }
    } finally {
      tunnelProbeInFlight = false;
      scheduleTunnelProbe();
    }
  }

  for (const processConfig of plan.processes) {
    launch(processConfig);
  }

  if (mode === 'all') scheduleTunnelProbe(Math.min(options.ngrokProbeIntervalMs, 5000));

  if (plan.openBrowser) {
    setTimeout(() => openUrl(plan.appUrl), plan.openBrowserDelayMs);
  }

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    lifecycleStatus = 'stopping';
    console.log('[start-all] Stopping services...');
    updateDevFlowSupervisorState({ shuttingDown: true });
    if (tunnelProbeTimer) clearTimeout(tunnelProbeTimer);
    tunnelProbeTimer = null;
    for (const label of Array.from(restartTimers.keys())) clearTimer(restartTimers, label);
    for (const label of Array.from(stableTimers.keys())) clearTimer(stableTimers, label);
    for (const [label, child] of children.entries()) {
      updateDevFlowSupervisorProcess(label, {
        status: 'stopped',
        pid: undefined,
        nextRetryAt: undefined,
        message: `${label} stopped during intentional supervisor shutdown.`,
      });
      stopManagedProcessTree(child);
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
