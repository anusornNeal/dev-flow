import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { taskRepository } from '../repositories/taskRepository.js';
import { groupTasksByLane, type Lanes } from './boardUtils.js';
import type { DomainTask } from '../domain/mappers/taskMapper.js';

export interface UseBoardViewModelOptions {
  projectId: string | null;
  pollIntervalMs?: number;
}

export interface UseBoardViewModel {
  tasks: DomainTask[];
  lanes: Lanes;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  setTasks: (updater: (prev: DomainTask[]) => DomainTask[]) => void;
}

export function useBoardViewModel(options: UseBoardViewModelOptions): UseBoardViewModel {
  const { projectId, pollIntervalMs = 5000 } = options;
  const [tasks, setTasksState] = useState<DomainTask[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const refresh = useCallback(async () => {
    if (!projectId) {
      setTasksState([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await taskRepository.list({ projectId });
      if (mountedRef.current) setTasksState(next);
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    refresh();
    if (!projectId) return;
    const interval = setInterval(() => {
      refresh();
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [projectId, pollIntervalMs, refresh]);

  const setTasks = useCallback((updater: (prev: DomainTask[]) => DomainTask[]) => {
    setTasksState((prev) => updater(prev));
  }, []);

  const lanes = useMemo(() => groupTasksByLane(tasks), [tasks]);

  return { tasks, lanes, loading, error, refresh, setTasks };
}
