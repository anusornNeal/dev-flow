import type { DomainTask } from '../domain/mappers/taskMapper.js';

export type Lane = 'backlog' | 'todo' | 'in-progress' | 'ready-for-review' | 'done';

export const LANES: Lane[] = ['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'];

const KNOWN_LANES = new Set<string>(LANES);

export type Lanes = Record<Lane, DomainTask[]>;

export function emptyLanes(): Lanes {
  return { backlog: [], todo: [], 'in-progress': [], 'ready-for-review': [], done: [] };
}

export function groupTasksByLane(tasks: DomainTask[]): Lanes {
  const lanes = emptyLanes();
  for (const task of tasks) {
    const status = String(task.status || '');
    const lane: Lane = KNOWN_LANES.has(status) ? (status as Lane) : 'backlog';
    lanes[lane].push(task);
  }
  return lanes;
}
