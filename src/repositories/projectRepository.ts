import { apiGet } from '../client/apiClient.js';
import { normalizeProjectListResponse } from '../client/responseNormalizers.js';
import { toDomainProject, type DomainProject } from '../domain/mappers/projectMapper.js';

export interface ProjectListOptions {
  mode?: 'summary' | 'standard';
  q?: string;
}

export const projectRepository = {
  async list(options: ProjectListOptions = {}): Promise<DomainProject[]> {
    const params = new URLSearchParams();
    if (options.mode) params.set('mode', options.mode);
    if (options.q) params.set('q', options.q);
    const path = params.toString() ? `/api/projects?${params.toString()}` : '/api/projects';
    const { data } = await apiGet<unknown>(path);
    return normalizeProjectListResponse(data).map(toDomainProject);
  },
};
