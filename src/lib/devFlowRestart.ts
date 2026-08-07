import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowAppRoot } from './devFlowPaths';

export const DEVFLOW_RESTART_EXIT_CODE = 75;
export const DEVFLOW_RESTART_ACK_DELAY_MS = 750;
export const DEVFLOW_RESTART_SUPERVISOR_ENV = 'DEVFLOW_RESTART_SUPERVISOR';
export const DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV = 'DEVFLOW_RESTART_SUPERVISOR_TOKEN';
export const DEVFLOW_RESTART_SUPERVISOR_START_ALL = 'start-all';

export type DevFlowRestartStatus = 'accepted' | 'restarting' | 'healthy' | 'failed';

export interface DevFlowRestartState {
  ticket: string;
  status: DevFlowRestartStatus;
  supervisor: string;
  supervisorToken?: string;
  requestedAt: string;
  updatedAt: string;
  requestedByPid: number;
  reason?: string;
  replacementPid?: number;
  message?: string;
}

export function getDevFlowRestartStatePath() {
  return path.join(getDevFlowAppRoot(), '.devflow', 'restart-state.json');
}

export function readDevFlowRestartState(): DevFlowRestartState | null {
  const statePath = getDevFlowRestartStatePath();
  if (!fs.existsSync(statePath)) return null;

  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as Partial<DevFlowRestartState>;
    if (!parsed.ticket || !parsed.status || !parsed.supervisor || !parsed.requestedAt || !parsed.updatedAt) {
      return null;
    }
    if (!Number.isInteger(parsed.requestedByPid)) return null;
    return parsed as DevFlowRestartState;
  } catch {
    return null;
  }
}

export function writeDevFlowRestartState(state: DevFlowRestartState) {
  const statePath = getDevFlowRestartStatePath();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
  return state;
}

export function updateDevFlowRestartState(
  ticket: string,
  patch: Partial<Omit<DevFlowRestartState, 'ticket' | 'requestedAt' | 'requestedByPid'>>,
) {
  const current = readDevFlowRestartState();
  if (!current || current.ticket !== ticket) return null;
  return writeDevFlowRestartState({
    ...current,
    ...patch,
    ticket: current.ticket,
    requestedAt: current.requestedAt,
    requestedByPid: current.requestedByPid,
    updatedAt: new Date().toISOString(),
  });
}

export function isDevFlowRestartPending(state = readDevFlowRestartState()) {
  return state?.status === 'accepted' || state?.status === 'restarting';
}

export function markDevFlowRestartRestarting(ticket: string, replacementPid?: number) {
  return updateDevFlowRestartState(ticket, {
    status: 'restarting',
    ...(Number.isInteger(replacementPid) ? { replacementPid } : {}),
    message: 'Restart supervisor is launching the replacement DevFlow server.',
  });
}

export function markDevFlowRestartHealthy(supervisorToken = String(process.env[DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV] || '').trim()) {
  const current = readDevFlowRestartState();
  if (!current || current.status !== 'restarting' || !supervisorToken || current.supervisorToken !== supervisorToken) return null;
  return updateDevFlowRestartState(current.ticket, {
    status: 'healthy',
    message: 'Replacement DevFlow server is listening and healthy.',
  });
}

export function markDevFlowRestartFailed(ticket: string, message: string) {
  return updateDevFlowRestartState(ticket, {
    status: 'failed',
    message: message.slice(0, 1000),
  });
}
