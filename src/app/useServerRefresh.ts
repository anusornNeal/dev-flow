import { useEffect } from 'react';
import { subscribeServerEvents } from '../lib/serverEvents';

interface ServerRefreshOptions {
  activeProjectId: string | null;
  refreshBoard: () => Promise<unknown> | unknown;
  refreshProjects: () => Promise<unknown> | unknown;
}

export function useServerRefresh({ activeProjectId, refreshBoard, refreshProjects }: ServerRefreshOptions) {
  useEffect(() => {
    let fallbackTimer: number | null = null;
    const stopFallback = () => {
      if (fallbackTimer === null) return;
      window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    };
    const runFallback = () => {
      void refreshBoard();
      void refreshProjects();
    };
    const startFallback = () => {
      if (fallbackTimer !== null) return;
      fallbackTimer = window.setInterval(runFallback, 60_000);
    };

    const unsubscribe = subscribeServerEvents((event) => {
      const affectsActiveProject = !event.projectId || event.projectId === activeProjectId;
      if (event.type === 'stream.reset') {
        runFallback();
        return;
      }
      if (event.type === 'task.changed' && affectsActiveProject) void refreshBoard();
      if (event.type === 'project.changed') void refreshProjects();
    }, {
      onAvailable: stopFallback,
      onUnavailable: startFallback,
    });
    startFallback();

    return () => {
      unsubscribe();
      stopFallback();
    };
  }, [activeProjectId, refreshBoard, refreshProjects]);
}
