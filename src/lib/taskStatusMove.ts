import type { TaskStatus } from '../types';

interface BuildTaskStatusMoveRequestOptions {
  emergency?: boolean;
  intent?: 'strict' | 'manual';
  manualOverride?: boolean;
}

export function buildTaskStatusMoveRequest(
  taskId: string,
  status: TaskStatus,
  options: BuildTaskStatusMoveRequestOptions = {},
) {
  const payload: { status: TaskStatus; emergency?: boolean; intent?: 'strict' | 'manual'; manualOverride?: boolean } = { status };
  if (options.emergency) payload.emergency = true;
  if (options.intent === 'manual' || options.manualOverride) payload.intent = 'manual';
  if (options.manualOverride) payload.manualOverride = true;

  return {
    url: `/api/tasks/${taskId}/move`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  };
}
