import type { TaskStatus } from '../types';

interface BuildTaskStatusMoveRequestOptions {
  emergency?: boolean;
}

export function buildTaskStatusMoveRequest(
  taskId: string,
  status: TaskStatus,
  options: BuildTaskStatusMoveRequestOptions = {},
) {
  const payload: { status: TaskStatus; emergency?: boolean } = { status };
  if (options.emergency) {
    payload.emergency = true;
  }

  return {
    url: `/api/tasks/${taskId}/move`,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  };
}
