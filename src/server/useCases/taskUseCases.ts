export interface TaskPatch {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  checklist?: ChecklistItem[];
  branch?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export interface TaskLike {
  id: string;
  status: string;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateTaskPatch(patch: TaskPatch): ValidationResult {
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string' || patch.title.trim().length === 0) {
      return { ok: false, reason: 'Task title is required and must be a non-empty string.' };
    }
  }
  return { ok: true };
}

export function isParentBlocked(siblings: TaskLike[], selfId: string): boolean {
  return siblings.some((s) => s.id !== selfId && s.status === 'in-progress');
}

export function applyChecklistToggle(items: ChecklistItem[], id: string): ChecklistItem[] {
  const idx = items.findIndex((i) => i.id === id);
  if (idx === -1) return items;
  const next = items.slice();
  next[idx] = { ...next[idx], completed: !next[idx].completed };
  return next;
}

export interface MoveDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluateMove(target: TaskLike, targetStatus: string): MoveDecision {
  if (targetStatus === 'ready-for-review' && target.status === 'in-progress' && !target) {
    return { allowed: false, reason: 'Cannot move to ready-for-review without an active agent run.' };
  }
  return { allowed: true };
}
