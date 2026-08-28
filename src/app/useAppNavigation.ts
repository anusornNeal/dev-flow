import { useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { apiClient } from '../client/apiClient';
import type { UiPreviewLinkedTask } from '../client/uiPreviewClient';
import type { Task } from '../types';

export type ActivePage = 'board' | 'previews' | 'agent-office';

function resolveActivePage(hash: string): ActivePage {
  return hash === '#previews' ? 'previews' : hash === '#agent-office' ? 'agent-office' : 'board';
}

interface NavigationOptions {
  activeProjectId: string | null;
  setActiveProjectId: Dispatch<SetStateAction<string | null>> | ((id: string | null) => void);
  setSelectedTask: Dispatch<SetStateAction<Task | null>>;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
}

export function useAppNavigation({ activeProjectId, setActiveProjectId, setSelectedTask, setPersistenceError }: NavigationOptions) {
  const [activePage, setActivePage] = useState<ActivePage>(() => resolveActivePage(window.location.hash));

  useEffect(() => {
    const syncPageFromHash = () => {
      if (window.location.hash === '#atlas') {
        window.history.replaceState('', document.title, window.location.pathname + window.location.search);
        setActivePage('board');
        return;
      }
      setActivePage(resolveActivePage(window.location.hash));
    };
    syncPageFromHash();
    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  const setPage = (page: ActivePage) => {
    setSelectedTask(null);
    setActivePage(page);
    const hash = page === 'previews' ? 'previews' : page === 'agent-office' ? 'agent-office' : '';
    if (hash) {
      if (window.location.hash !== `#${hash}`) window.location.hash = hash;
      return;
    }
    if (window.location.hash) window.history.pushState('', document.title, window.location.pathname + window.location.search);
  };

  const openPreviewTask = async (task: UiPreviewLinkedTask) => {
    try {
      if (task.projectId && task.projectId !== activeProjectId) setActiveProjectId(task.projectId);
      const result = await apiClient.fetchJson<Task>('GET', `/api/tasks/${encodeURIComponent(task.id)}?mode=standard`);
      setPage('board');
      setSelectedTask(result.data);
      setPersistenceError(null);
    } catch (error) {
      setPersistenceError(error instanceof Error ? `Could not open linked task: ${error.message}` : 'Could not open linked task.');
    }
  };

  const openAgentOfficeTask = async (taskId: string) => {
    try {
      const result = await apiClient.fetchJson<Task>('GET', `/api/tasks/${encodeURIComponent(taskId)}?mode=standard`);
      setSelectedTask(result.data);
      setPersistenceError(null);
    } catch (error) {
      setPersistenceError(error instanceof Error ? `Could not open monitored task: ${error.message}` : 'Could not open monitored task.');
    }
  };

  return { activePage, setPage, openPreviewTask, openAgentOfficeTask };
}
