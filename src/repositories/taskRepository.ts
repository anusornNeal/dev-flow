import { apiGet } from '../client/apiClient.js';
import { toDomainTask, type DomainTask } from '../domain/mappers/taskMapper.js';

export interface TaskListOptions {
  projectId?: string;
  status?: string;
}

export const taskRepository = {
  async list(options: TaskListOptions = {}): Promise<DomainTask[]> {
    const params = new URLSearchParams();
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.status) params.set('status', options.status);
    const path = params.toString() ? `/api/tasks?${params.toString()}` : '/api/tasks';
    const { data } = await apiGet<{ tasks: any[] }>(path);
    return (data.tasks || []).map(toDomainTask);
  },

  async get(taskId: string): Promise<DomainTask> {
    const { data } = await apiGet<any>(`/api/tasks/${encodeURIComponent(taskId)}`);
    return toDomainTask(data);
  },
};
