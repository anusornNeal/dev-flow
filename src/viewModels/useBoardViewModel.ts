import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { taskRepository } from '../repositories/taskRepository.js';
import { groupTasksByLane, LANES, type Lane, type Lanes } from './boardUtils.js';
import { mergeWithPendingMoves } from './boardOptimisticMerge.js';
import type { DomainTask } from '../domain/mappers/taskMapper.js';

export const BOARD_PAGE_SIZE = 25;
const PAGE_SIZE = BOARD_PAGE_SIZE;

export interface UseBoardViewModelOptions {
  projectId: string | null;
  pollIntervalMs?: number;
}

export interface BoardLanePageState {
  total: number;
  loaded: number;
  hasMore: boolean;
  loading: boolean;
}

export type BoardLanePages = Record<Lane, BoardLanePageState>;

function emptyLanePages(): BoardLanePages {
  return Object.fromEntries(LANES.map((lane) => [lane, { total: 0, loaded: 0, hasMore: false, loading: false }])) as BoardLanePages;
}

function initialLoadedLimits(): Record<Lane, number> {
  return Object.fromEntries(LANES.map((lane) => [lane, PAGE_SIZE])) as Record<Lane, number>;
}

function mergeUniqueTasks(tasks: DomainTask[]) {
  const byId = new Map<string, DomainTask>();
  for (const task of tasks) byId.set(task.id, task);
  return Array.from(byId.values());
}
export function getBoardLaneRefreshLimit(loaded: number) {
  return Math.max(BOARD_PAGE_SIZE, Number.isFinite(loaded) ? loaded : 0);
}

export function mergeBoardTaskPage(
  previous: DomainTask[],
  incoming: DomainTask[],
  pendingIds: ReadonlySet<string>,
) {
  return mergeWithPendingMoves(mergeUniqueTasks([...previous, ...incoming]), previous, new Set(pendingIds));
}

export function updateBoardLanePageState(
  previous: BoardLanePages,
  lane: Lane,
  page: { total: number; itemCount: number; hasMore: boolean; mode: 'refresh' | 'append' },
): BoardLanePages {
  const loaded = page.mode === 'append'
    ? previous[lane].loaded + page.itemCount
    : page.itemCount;
  return {
    ...previous,
    [lane]: {
      total: page.total,
      loaded,
      hasMore: page.hasMore,
      loading: false,
    },
  };
}

export interface UseBoardViewModel {
  tasks: DomainTask[];
  lanes: Lanes;
  lanePages: BoardLanePages;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  loadMore: (lane: Lane) => Promise<void>;
  setTaskPending: (taskId: string, pending: boolean) => void;
  setTasks: (updater: (prev: DomainTask[]) => DomainTask[]) => void;
  applyServerTasks: (serverTasks: DomainTask[], pendingIds: ReadonlySet<string>) => void;
}

export function useBoardViewModel(options: UseBoardViewModelOptions): UseBoardViewModel {
  const { projectId, pollIntervalMs = 5000 } = options;
  const [tasks, setTasksState] = useState<DomainTask[]>([]);
  const [lanePages, setLanePages] = useState<BoardLanePages>(() => emptyLanePages());
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const loadedLimitsRef = useRef<Record<Lane, number>>(initialLoadedLimits());
  const pendingIdsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!projectId) {
      setTasksState([]);
      setLanePages(emptyLanePages());
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const pages = await Promise.all(LANES.map(async (lane) => {
        const limit = getBoardLaneRefreshLimit(loadedLimitsRef.current[lane]);
        const page = await taskRepository.listPage({ projectId, status: lane, limit, offset: 0 });
        return { lane, page };
      }));
      if (!mountedRef.current) return;

      const serverTasks = mergeUniqueTasks(pages.flatMap(({ page }) => [...page.items, ...page.relatedItems]));
      setTasksState((prev) => mergeWithPendingMoves(serverTasks, prev, pendingIdsRef.current));
      setLanePages((prev) => {
        let next = { ...prev };
        for (const { lane, page } of pages) {
          loadedLimitsRef.current[lane] = getBoardLaneRefreshLimit(page.items.length);
          next = updateBoardLanePageState(next, lane, {
            total: page.total,
            itemCount: page.items.length,
            hasMore: page.hasMore,
            mode: 'refresh',
          });
        }
        return next;
      });
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [projectId]);

  const loadMore = useCallback(async (lane: Lane) => {
    if (!projectId) return;
    const currentOffset = lanePages[lane].loaded;
    if (lanePages[lane].loading || !lanePages[lane].hasMore) return;
    setLanePages((prev) => ({ ...prev, [lane]: { ...prev[lane], loading: true } }));
    try {
      const page = await taskRepository.listPage({ projectId, status: lane, limit: PAGE_SIZE, offset: currentOffset });
      if (!mountedRef.current) return;
      const incoming = [...page.items, ...page.relatedItems];
      setTasksState((prev) => mergeBoardTaskPage(prev, incoming, pendingIdsRef.current));
      const loaded = currentOffset + page.items.length;
      loadedLimitsRef.current[lane] = getBoardLaneRefreshLimit(loaded);
      setLanePages((prev) => updateBoardLanePageState(prev, lane, {
        total: page.total,
        itemCount: page.items.length,
        hasMore: page.hasMore,
        mode: 'append',
      }));
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
        setLanePages((prev) => ({ ...prev, [lane]: { ...prev[lane], loading: false } }));
      }
    }
  }, [lanePages, projectId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    loadedLimitsRef.current = initialLoadedLimits();
    pendingIdsRef.current.clear();
    setLanePages(emptyLanePages());
    refresh();
    if (!projectId) return;
    const interval = setInterval(() => {
      refresh();
    }, pollIntervalMs);
    return () => clearInterval(interval);
  }, [projectId, pollIntervalMs, refresh]);

  const setTaskPending = useCallback((taskId: string, pending: boolean) => {
    if (pending) pendingIdsRef.current.add(taskId);
    else pendingIdsRef.current.delete(taskId);
  }, []);

  const setTasks = useCallback((updater: (prev: DomainTask[]) => DomainTask[]) => {
    setTasksState((prev) => updater(prev));
  }, []);

  const applyServerTasks = useCallback((serverTasks: DomainTask[], pendingIds: ReadonlySet<string>) => {
    setTasksState((prev) => mergeWithPendingMoves(serverTasks, prev, new Set(pendingIds)));
  }, []);

  const lanes = useMemo(() => groupTasksByLane(tasks), [tasks]);

  return { tasks, lanes, lanePages, loading, error, refresh, loadMore, setTaskPending, setTasks, applyServerTasks };
}
