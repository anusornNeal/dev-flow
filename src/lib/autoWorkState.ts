import type { Task } from '../types';

export type AutoWorkStateKind =
  | 'queued-busy'
  | 'queued'
  | 'launching'
  | 'running'
  | 'ready-for-review'
  | 'failed'
  | 'timed-out'
  | 'stopped';

export interface AutoWorkState {
  kind: AutoWorkStateKind;
  label: string;
  message?: string | null;
}

const QUEUED_BUSY_PREFIX = 'Auto Work queued: assigned agent ';

function getLatestBusyQueueMessage(task: Task): string | null {
  if (task.status !== 'todo') return null;
  const logs = Array.isArray(task.logs) ? [...task.logs].reverse() : [];
  const match = logs.find((entry) => typeof entry?.message === 'string' && entry.message.startsWith(QUEUED_BUSY_PREFIX));
  return match?.message || null;
}

export function getAutoWorkState(task: Task): AutoWorkState | null {
  const busyMessage = getLatestBusyQueueMessage(task);
  if (busyMessage && !task.activeAgent) {
    return {
      kind: 'queued-busy',
      label: 'Queued',
      message: busyMessage,
    };
  }

  const latestRun = task.latestAgentRun;
  if (!latestRun) return null;

  if (latestRun.status === 'queued') {
    return { kind: 'queued', label: 'Queued' };
  }
  if (latestRun.status === 'starting') {
    return { kind: 'launching', label: 'Launching' };
  }
  if (latestRun.status === 'running') {
    return { kind: 'running', label: 'Running' };
  }
  if (latestRun.status === 'succeeded') {
    return { kind: 'ready-for-review', label: 'Ready for review' };
  }
  if (latestRun.status === 'failed') {
    return {
      kind: /stale|timed out|timeout/i.test(latestRun.errorMessage || '') ? 'timed-out' : 'failed',
      label: /stale|timed out|timeout/i.test(latestRun.errorMessage || '') ? 'Timed out' : 'Failed',
      message: latestRun.errorMessage || null,
    };
  }
  return {
    kind: 'stopped',
    label: 'Stopped',
    message: latestRun.errorMessage || null,
  };
}
