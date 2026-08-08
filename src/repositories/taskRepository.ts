import { apiGet } from '../client/apiClient.js';
import { normalizeTaskListResponse } from '../client/responseNormalizers.js';
import { toDomainTask, type DomainTask } from '../domain/mappers/taskMapper.js';

export interface TaskListOptions {
  projectId?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface TaskListPage {
  items: DomainTask[];
  relatedItems: DomainTask[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export const taskRepository = {
  async listPage(options: TaskListOptions = {}): Promise<TaskListPage> {
    const params = new URLSearchParams();
    params.set('mode', 'board');
    if (options.projectId) params.set('projectId', options.projectId);
    if (options.status) params.set('status', options.status);
    if (Number.isFinite(options.limit)) params.set('limit', String(options.limit));
    if (Number.isFinite(options.offset)) params.set('offset', String(options.offset));
    const path = `/api/tasks?${params.toString()}`;
    const { data } = await apiGet<any>(path);
    const items = normalizeTaskListResponse(data).map(toDomainTask);
    const relatedItems = Array.isArray(data?.relatedItems) ? data.relatedItems.map(toDomainTask) : [];
    return {
      items,
      relatedItems,
      total: Number.isFinite(Number(data?.total)) ? Number(data.total) : items.length,
      limit: Number.isFinite(Number(data?.limit)) ? Number(data.limit) : items.length,
      offset: Number.isFinite(Number(data?.offset)) ? Number(data.offset) : 0,
      hasMore: data?.hasMore === true,
    };
  },
  async list(options: TaskListOptions = {}): Promise<DomainTask[]> {
    const page = await this.listPage(options);
    return [...page.items, ...page.relatedItems];
  },

  async get(taskId: string): Promise<DomainTask> {
    const { data } = await apiGet<any>(`/api/tasks/${encodeURIComponent(taskId)}?mode=full`);
    return toDomainTask(data);
  },
};
