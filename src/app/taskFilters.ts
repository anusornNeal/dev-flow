import type { Task } from '../types';

export interface TaskFilterOptions {
  activeProjectId: string;
  selectedPriority: Task['priority'] | 'all';
  selectedTag: string | 'all';
  searchQuery: string;
}

function taskMatchesSearch(task: Task, query: string) {
  return !query
    || task.title.toLowerCase().includes(query)
    || task.id.toLowerCase().includes(query)
    || Boolean(task.branch && task.branch.toLowerCase().includes(query));
}

function taskMatchesFilters(task: Task, options: TaskFilterOptions) {
  const matchesPriority = options.selectedPriority === 'all' || task.priority === options.selectedPriority;
  const matchesTag = options.selectedTag === 'all' || task.tags.includes(options.selectedTag);
  const query = options.searchQuery.trim().toLowerCase();
  return matchesPriority && matchesTag && taskMatchesSearch(task, query);
}

export function filterBoardTasks(tasks: Task[], options: TaskFilterOptions) {
  return tasks.filter((task) => {
    if (task.projectId !== options.activeProjectId) return false;
    if (taskMatchesFilters(task, options)) return true;

    if (task.parentId) return false;
    return tasks
      .filter((candidate) => candidate.parentId === task.id && candidate.projectId === options.activeProjectId)
      .some((childTask) => taskMatchesFilters(childTask, options));
  });
}
