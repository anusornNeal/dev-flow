import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { taskRepository } from '../repositories/taskRepository.js';
import { groupTasksByLane, LANES, type Lane, type Lanes } from './boardUtils.js';
import { mergeWithPendingMoves } from './boardOptimisticMerge.js';
import type { DomainTask } from '../domain/mappers/taskMapper.js';

export const BOARD_PAGE_SIZE = 25;
const PAGE_SIZE = BOARD_PAGE_SIZE;

export interface UseBoardViewModelOptions {
  projectId: string | null;
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

export type BoardRefreshToken = { projectId: string; generation: number };

export function createBoardRefreshCoordinator() {
  let activeProjectId: string | null = null;
  let generation = 0;
  let inFlight = false;
  let queued = false;

  const reset = (projectId: string | null) => {
    if (activeProjectId === projectId) return;
    activeProjectId = projectId;
    generation += 1;
    inFlight = false;
    queued = false;
  };

  return {
    reset,
    begin(projectId: string | null): BoardRefreshToken | null {
      reset(projectId);
      if (!projectId) return null;
      if (inFlight) {
        queued = true;
        return null;
      }
      inFlight = true;
      return { projectId, generation };
    },
    finish(token: BoardRefreshToken) {
      if (token.projectId !== activeProjectId || token.generation !== generation) {
        return { apply: false, rerun: false };
      }
      inFlight = false;
      const rerun = queued;
      queued = false;
      return { apply: true, rerun };
    },
  };
}

export function shouldShowBoardInitialLoading(hasSnapshot: boolean) {
  return !hasSnapshot;
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
  const { projectId } = options;
  const [tasks, setTasksState] = useState<DomainTask[]>([]);
  const [lanePages, setLanePages] = useState<BoardLanePages>(() => emptyLanePages());
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const activeProjectRef = useRef<string | null>(projectId);
  const loadedLimitsRef = useRef<Record<Lane, number>>(initialLoadedLimits());
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const hasSnapshotRef = useRef(false);
  const refreshCoordinatorRef = useRef(createBoardRefreshCoordinator());

  const refresh = useCallback(async () => {
    const token = refreshCoordinatorRef.current.begin(projectId);
    if (!token) return;

    const initialLoad = shouldShowBoardInitialLoading(hasSnapshotRef.current);
    if (initialLoad) setLoading(true);
    setError(null);
    let completion = { apply: false, rerun: false };

    try {
      const pages = await Promise.all(LANES.map(async (lane) => {
        const limit = getBoardLaneRefreshLimit(loadedLimitsRef.current[lane]);
        const page = await taskRepository.listPage({ projectId: token.projectId, status: lane, limit, offset: 0 });
        return { lane, page };
      }));
      completion = refreshCoordinatorRef.current.finish(token);
      if (!completion.apply || !mountedRef.current) return;

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
      hasSnapshotRef.current = true;
    } catch (err) {
      completion = refreshCoordinatorRef.current.finish(token);
      if (completion.apply && mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (completion.apply && initialLoad && mountedRef.current) setLoading(false);
      if (completion.rerun && mountedRef.current) queueMicrotask(() => { void refresh(); });
    }
  }, [projectId]);

  const loadMore = useCallback(async (lane: Lane) => {
    if (!projectId) return;
    const currentOffset = lanePages[lane].loaded;
    if (lanePages[lane].loading || !lanePages[lane].hasMore) return;
    setLanePages((prev) => ({ ...prev, [lane]: { ...prev[lane], loading: true } }));
    try {
      const page = await taskRepository.listPage({ projectId, status: lane, limit: PAGE_SIZE, offset: currentOffset });
      if (!mountedRef.current || activeProjectRef.current !== projectId) return;
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
    activeProjectRef.current = projectId;
    refreshCoordinatorRef.current.reset(projectId);
    loadedLimitsRef.current = initialLoadedLimits();
    pendingIdsRef.current.clear();
    hasSnapshotRef.current = false;
    setTasksState([]);
    setLanePages(emptyLanePages());
    setError(null);
    setLoading(Boolean(projectId));
    void refresh();
  }, [projectId, refresh]);

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
