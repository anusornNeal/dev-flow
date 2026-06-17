import type { DomainTask } from '../domain/mappers/taskMapper.js';

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface EditState {
  title: string;
  description: string;
  status: string;
  priority: string;
  checklist: ChecklistItem[];
  branch: string;
  tags: string[];
  acceptanceCriteria: string;
  verification: string;
  reasoning: string;
  repoContext: string;
  specUrl: string;
  jiraKey: string;
  sourceUrl: string;
}

export const EDITABLE_FIELDS: ReadonlyArray<keyof EditState> = [
  'title',
  'description',
  'status',
  'priority',
  'checklist',
  'branch',
  'tags',
  'acceptanceCriteria',
  'verification',
  'reasoning',
  'repoContext',
  'specUrl',
  'jiraKey',
  'sourceUrl',
];

export function buildEditStateFromTask(task: DomainTask): EditState {
  return {
    title: String(task.title || ''),
    description: String((task as any).description || ''),
    status: String((task as any).status || 'todo'),
    priority: String((task as any).priority || 'medium'),
    checklist: Array.isArray((task as any).checklist) ? [...((task as any).checklist as ChecklistItem[])] : [],
    branch: String((task as any).branch || ''),
    tags: Array.isArray((task as any).tags) ? [...((task as any).tags as string[])] : [],
    acceptanceCriteria: String((task as any).acceptanceCriteria || ''),
    verification: String((task as any).verification || ''),
    reasoning: String((task as any).reasoning || ''),
    repoContext: String((task as any).repoContext || ''),
    specUrl: String((task as any).specUrl || ''),
    jiraKey: String((task as any).jiraKey || ''),
    sourceUrl: String((task as any).sourceUrl || ''),
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const k of aKeys) {
      if (!deepEqual((a as any)[k], (b as any)[k])) return false;
    }
    return true;
  }
  return false;
}

export function diffEditState(baseline: EditState, current: EditState): Array<keyof EditState> {
  const changed: Array<keyof EditState> = [];
  for (const field of EDITABLE_FIELDS) {
    if (!deepEqual(baseline[field], current[field])) {
      changed.push(field);
    }
  }
  return changed;
}

export function toggleChecklistItem(
  items: ChecklistItem[],
  id: string,
): ChecklistItem[] {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = { ...next[idx], completed: !next[idx].completed };
  return next;
}
