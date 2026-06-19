import { apiGet } from '../client/apiClient.js';
import { normalizeTaskListResponse } from '../client/responseNormalizers.js';
import { toDomainTask, type DomainTask } from '../domain/mappers/taskMapper.js';

export interface TaskListOptions {
  projectId?: string;
  status?: string;
}

export const taskRepository = {
  async list(options: TaskListOptions = {}): Promise<DomainTask[]> {
    const params = new URLSearchParams();
    params.set('mode', 'board');
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.status) params.set('status', options.status);
    const path = `/api/tasks?${params.toString()}`;
    const { data } = await apiGet<unknown>(path);
    return normalizeTaskListResponse(data).map(toDomainTask);
  },

  async get(taskId: string): Promise<DomainTask> {
    const { data } = await apiGet<any>(`/api/tasks/${encodeURIComponent(taskId)}?mode=full`);
    return toDomainTask(data);
  },
};
