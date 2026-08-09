import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowRuntimeDir } from './devFlowPaths';

export const DEVFLOW_SUPERVISOR_STATE_VERSION = 1 as const;
export const DEVFLOW_SUPERVISOR_NAME = 'start-all' as const;

export type DevFlowSupervisorMode = 'all' | 'server-only';
export type DevFlowSupervisorProcessLabel = 'server' | 'ngrok';
export type DevFlowSupervisorProcessStatus = 'starting' | 'running' | 'restarting' | 'stopped' | 'failed';

export type DevFlowSupervisorProcessState = {
  label: DevFlowSupervisorProcessLabel;
  status: DevFlowSupervisorProcessStatus;
  pid?: number;
  startedAt?: string;
  lastExitAt?: string;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  restartAttempt: number;
  nextRetryAt?: string;
  message?: string;
};

export type DevFlowSupervisorState = {
  version: typeof DEVFLOW_SUPERVISOR_STATE_VERSION;
  supervisor: typeof DEVFLOW_SUPERVISOR_NAME;
  mode: DevFlowSupervisorMode;
  shuttingDown: boolean;
  startedAt: string;
  updatedAt: string;
  processes: Partial<Record<DevFlowSupervisorProcessLabel, DevFlowSupervisorProcessState>>;
};

export type DevFlowSupervisorChildDiagnostic = {
  enabled: boolean;
  status: 'healthy' | 'restarting' | 'down' | 'disabled' | 'unknown';
  processStatus?: DevFlowSupervisorProcessStatus;
  pid?: number;
  restartAttempt: number;
  nextRetryAt?: string;
  lastExitAt?: string;
  lastExitCode?: number | null;
  lastSignal?: string | null;
  message?: string;
};

export function getDevFlowSupervisorStatePath() {
  return path.join(getDevFlowRuntimeDir(), 'supervisor-state.json');
}

function isSupervisorMode(value: unknown): value is DevFlowSupervisorMode {
  return value === 'all' || value === 'server-only';
}

function isProcessStatus(value: unknown): value is DevFlowSupervisorProcessStatus {
  return value === 'starting'
    || value === 'running'
    || value === 'restarting'
    || value === 'stopped'
    || value === 'failed';
}

function normalizeProcessState(label: DevFlowSupervisorProcessLabel, value: unknown): DevFlowSupervisorProcessState | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Record<string, unknown>;
  if (!isProcessStatus(input.status)) return undefined;
  return {
    label,
    status: input.status,
    ...(Number.isInteger(input.pid) ? { pid: Number(input.pid) } : {}),
    ...(typeof input.startedAt === 'string' ? { startedAt: input.startedAt } : {}),
    ...(typeof input.lastExitAt === 'string' ? { lastExitAt: input.lastExitAt } : {}),
    ...(input.lastExitCode === null || Number.isInteger(input.lastExitCode) ? { lastExitCode: input.lastExitCode as number | null } : {}),
    ...(input.lastSignal === null || typeof input.lastSignal === 'string' ? { lastSignal: input.lastSignal as string | null } : {}),
    restartAttempt: Number.isInteger(input.restartAttempt) && Number(input.restartAttempt) >= 0 ? Number(input.restartAttempt) : 0,
    ...(typeof input.nextRetryAt === 'string' ? { nextRetryAt: input.nextRetryAt } : {}),
    ...(typeof input.message === 'string' ? { message: input.message } : {}),
  };
}

export function createDevFlowSupervisorState(input: {
  mode: DevFlowSupervisorMode;
  processLabels: DevFlowSupervisorProcessLabel[];
  now?: string;
}): DevFlowSupervisorState {
  const now = input.now || new Date().toISOString();
  const processes: DevFlowSupervisorState['processes'] = {};
  for (const label of Array.from(new Set(input.processLabels))) {
    processes[label] = { label, status: 'starting', restartAttempt: 0 };
  }
  return {
    version: DEVFLOW_SUPERVISOR_STATE_VERSION,
    supervisor: DEVFLOW_SUPERVISOR_NAME,
    mode: input.mode,
    shuttingDown: false,
    startedAt: now,
    updatedAt: now,
    processes,
  };
}

export function readDevFlowSupervisorState(): DevFlowSupervisorState | null {
  const statePath = getDevFlowSupervisorStatePath();
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    if (parsed.version !== DEVFLOW_SUPERVISOR_STATE_VERSION || parsed.supervisor !== DEVFLOW_SUPERVISOR_NAME || !isSupervisorMode(parsed.mode)) {
      return null;
    }
    if (typeof parsed.startedAt !== 'string' || typeof parsed.updatedAt !== 'string') return null;
    const rawProcesses = parsed.processes && typeof parsed.processes === 'object'
      ? parsed.processes as Record<string, unknown>
      : {};
    const processes: DevFlowSupervisorState['processes'] = {};
    for (const label of ['server', 'ngrok'] as const) {
      const normalized = normalizeProcessState(label, rawProcesses[label]);
      if (normalized) processes[label] = normalized;
    }
    return {
      version: DEVFLOW_SUPERVISOR_STATE_VERSION,
      supervisor: DEVFLOW_SUPERVISOR_NAME,
      mode: parsed.mode,
      shuttingDown: parsed.shuttingDown === true,
      startedAt: parsed.startedAt,
      updatedAt: parsed.updatedAt,
      processes,
    };
  } catch {
    return null;
  }
}

export function writeDevFlowSupervisorState(state: DevFlowSupervisorState) {
  const statePath = getDevFlowSupervisorStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export function updateDevFlowSupervisorState(
  patch: Partial<Pick<DevFlowSupervisorState, 'shuttingDown'>>,
  now = new Date().toISOString(),
) {
  const current = readDevFlowSupervisorState();
  if (!current) return null;
  return writeDevFlowSupervisorState({ ...current, ...patch, updatedAt: now });
}

export function updateDevFlowSupervisorProcess(
  label: DevFlowSupervisorProcessLabel,
  patch: Partial<Omit<DevFlowSupervisorProcessState, 'label'>>,
  now = new Date().toISOString(),
) {
  const current = readDevFlowSupervisorState();
  if (!current) return null;
  const previous = current.processes[label] || { label, status: 'starting' as const, restartAttempt: 0 };
  const next: DevFlowSupervisorProcessState = { ...previous, ...patch, label };
  return writeDevFlowSupervisorState({
    ...current,
    updatedAt: now,
    processes: { ...current.processes, [label]: next },
  });
}

function childDiagnostic(
  state: DevFlowSupervisorState,
  label: DevFlowSupervisorProcessLabel,
  enabled: boolean,
): DevFlowSupervisorChildDiagnostic {
  if (!enabled) return { enabled: false, status: 'disabled', restartAttempt: 0 };
  const child = state.processes[label];
  if (!child) return { enabled: true, status: 'unknown', restartAttempt: 0 };
  const status = child.status === 'running'
    ? 'healthy'
    : child.status === 'starting' || child.status === 'restarting'
      ? 'restarting'
      : 'down';
  return {
    enabled: true,
    status,
    processStatus: child.status,
    ...(Number.isInteger(child.pid) ? { pid: child.pid } : {}),
    restartAttempt: child.restartAttempt,
    ...(child.nextRetryAt ? { nextRetryAt: child.nextRetryAt } : {}),
    ...(child.lastExitAt ? { lastExitAt: child.lastExitAt } : {}),
    ...('lastExitCode' in child ? { lastExitCode: child.lastExitCode } : {}),
    ...('lastSignal' in child ? { lastSignal: child.lastSignal } : {}),
    ...(child.message ? { message: child.message } : {}),
  };
}

export function buildDevFlowSupervisorDiagnostics(state: DevFlowSupervisorState | null = readDevFlowSupervisorState()) {
  if (!state) {
    return {
      available: false,
      summary: 'unavailable' as const,
      api: { enabled: true, status: 'unknown' as const, restartAttempt: 0 },
      tunnel: { enabled: false, status: 'unknown' as const, restartAttempt: 0 },
    };
  }

  const api = childDiagnostic(state, 'server', true);
  const tunnel = childDiagnostic(state, 'ngrok', state.mode === 'all');
  let summary = 'degraded';
  if (state.shuttingDown) summary = 'shutting-down';
  else if (!tunnel.enabled && api.status === 'healthy') summary = 'api-healthy-tunnel-disabled';
  else if (api.status === 'healthy' && tunnel.status === 'healthy') summary = 'both-healthy';
  else if (api.status === 'healthy' && tunnel.status === 'restarting') summary = 'api-healthy-tunnel-restarting';
  else if (api.status === 'healthy' && tunnel.status === 'down') summary = 'api-healthy-tunnel-down';
  else if (api.status === 'down' && tunnel.status === 'healthy') summary = 'api-down-tunnel-healthy';
  else if (api.status === 'restarting' && tunnel.status === 'healthy') summary = 'api-restarting-tunnel-healthy';

  return {
    available: true,
    supervisor: state.supervisor,
    mode: state.mode,
    summary,
    shuttingDown: state.shuttingDown,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    stateAgeMs: Math.max(0, Date.now() - Date.parse(state.updatedAt)),
    api,
    tunnel,
  };
}
