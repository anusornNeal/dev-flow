import type { Dispatch, SetStateAction } from 'react';
import { apiClient } from '../client/apiClient';
import type { Project } from '../types';

interface ProjectViewModelLike {
  projects: Array<{ id: string }>;
  activeProjectId: string | null;
  refresh: () => Promise<unknown>;
}

interface ProjectActionsOptions {
  projectsViewModel: ProjectViewModelLike;
  setActiveProjectId: Dispatch<SetStateAction<string | null>> | ((id: string | null) => void);
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
}

export function useProjectActions({ projectsViewModel, setActiveProjectId, setPersistenceError }: ProjectActionsOptions) {
  const refreshProjects = async () => {
    try {
      await projectsViewModel.refresh();
      setPersistenceError(null);
      const list = projectsViewModel.projects;
      if (list.length > 0) {
        const currentId = projectsViewModel.activeProjectId;
        const isValidId = list.some((project) => project.id === currentId);
        setActiveProjectId(isValidId ? currentId : list[0].id);
      }
    } catch (error) {
      console.warn('Backend projects API connection unavailable:', error);
      setPersistenceError('Project data is unavailable because the backend could not be reached. No local fallback was used.');
    }
  };

  const createProject = async (name: string, repoUrl: string, description?: string, localPath?: string, taskIdPrefix?: string) => {
    try {
      const { data: newProject } = await apiClient.fetchJson<{ id: string }>('POST', '/api/projects', { name, repoUrl, description, localPath, taskIdPrefix });
      await projectsViewModel.refresh();
      setActiveProjectId(newProject.id);
      return true;
    } catch (error) {
      console.error('Failed to create project:', error);
      setPersistenceError('Project creation failed before the backend confirmed persistence.');
      return false;
    }
  };

  const deleteProject = async (id: string) => {
    try {
      await apiClient.fetchJson('DELETE', `/api/projects/${encodeURIComponent(id)}`);
      const remainingProjects = projectsViewModel.projects.filter((project) => project.id !== id);
      await projectsViewModel.refresh();
      if (projectsViewModel.activeProjectId === id) {
        setActiveProjectId(remainingProjects.length > 0 ? remainingProjects[0].id : null);
      }
      return true;
    } catch (error) {
      console.error('Failed to delete project:', error);
      setPersistenceError('Project deletion failed before the backend confirmed persistence.');
      return false;
    }
  };

  const updateProject = async (id: string, updates: Partial<Project>) => {
    try {
      await apiClient.fetchJson('PUT', `/api/projects/${encodeURIComponent(id)}`, updates);
      await projectsViewModel.refresh();
      return true;
    } catch (error) {
      console.error('Failed to update project:', error);
      setPersistenceError('Project update failed before the backend confirmed persistence.');
      return false;
    }
  };

  return { refreshProjects, createProject, deleteProject, updateProject };
}
