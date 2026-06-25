import { useCallback, useEffect, useState } from 'react';
import type { Project } from '../types';

interface ProjectSelectionViewModel {
  activeProjectId: string | null;
  setActiveProjectId: (id: string | null) => void;
}

export function useActiveProjectBootstrap(
  projects: Project[],
  projectsViewModel: ProjectSelectionViewModel,
) {
  useEffect(() => {
    try {
      const legacy = localStorage.getItem('devflow_selected_project');
      const modern = localStorage.getItem('devflow.activeProjectId');
      if (legacy && !modern) {
        localStorage.setItem('devflow.activeProjectId', legacy);
      }
    } catch {
      // localStorage unavailable - non-fatal
    }
  }, []);

  const [bootstrapProjectId, setBootstrapProjectId] = useState<string>('');

  useEffect(() => {
    if (bootstrapProjectId) return;
    if (projectsViewModel.activeProjectId) {
      setBootstrapProjectId(projectsViewModel.activeProjectId);
      return;
    }
    if (projects.length > 0) {
      const first = projects[0];
      projectsViewModel.setActiveProjectId(first.id);
      setBootstrapProjectId(first.id);
    }
  }, [bootstrapProjectId, projectsViewModel, projects]);

  const setActiveProjectId = useCallback((id: string) => {
    projectsViewModel.setActiveProjectId(id || null);
    if (id) setBootstrapProjectId(id);
  }, [projectsViewModel]);

  return {
    activeProjectId: projectsViewModel.activeProjectId || bootstrapProjectId,
    setActiveProjectId,
  };
}
