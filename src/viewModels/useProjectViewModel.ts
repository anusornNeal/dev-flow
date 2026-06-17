import { useCallback, useEffect, useState } from 'react';
import { projectRepository } from '../repositories/projectRepository.js';
import type { DomainProject } from '../domain/mappers/projectMapper.js';

const ACTIVE_PROJECT_KEY = 'devflow.activeProjectId';

export interface UseProjectViewModel {
  projects: DomainProject[];
  activeProjectId: string | null;
  loading: boolean;
  error: string | null;
  setActiveProjectId: (id: string | null) => void;
  refresh: () => Promise<void>;
}

export function useProjectViewModel(): UseProjectViewModel {
  const [projects, setProjects] = useState<DomainProject[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(() => {
    try {
      return localStorage.getItem(ACTIVE_PROJECT_KEY);
    } catch {
      return null;
    }
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await projectRepository.list();
      setProjects(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setActiveProjectId = useCallback((id: string | null) => {
    setActiveProjectIdState(id);
    try {
      if (id) localStorage.setItem(ACTIVE_PROJECT_KEY, id);
      else localStorage.removeItem(ACTIVE_PROJECT_KEY);
    } catch {
      // localStorage unavailable - non-fatal
    }
  }, []);

  return { projects, activeProjectId, loading, error, setActiveProjectId, refresh };
}
