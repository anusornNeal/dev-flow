import type { DomainTask } from '../domain/mappers/taskMapper.js';

export function shallowEqualTasks(a: DomainTask[], b: DomainTask[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function mergeWithPendingMoves(
  serverTasks: DomainTask[],
  prev: DomainTask[],
  pendingIds: Set<string>,
): DomainTask[] {
  if (pendingIds.size === 0) {
    return shallowEqualTasks(serverTasks, prev) ? prev : serverTasks;
  }
  const prevById = new Map<string, DomainTask>();
  for (const t of prev) prevById.set(t.id, t);
  const merged = serverTasks.map((serverTask) => {
    if (pendingIds.has(serverTask.id)) {
      const optimistic = prevById.get(serverTask.id);
      return optimistic || serverTask;
    }
    return serverTask;
  });
  return merged;
}
