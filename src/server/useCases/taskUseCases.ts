export interface TaskPatch {
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  category?: string;
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
  bugs?: BugThreadLike[];
  updatedAt?: string;
}

export type BugStatus = 'open' | 'fixing' | 'fixed' | 'verified' | 'reopened' | 'archived';
export type BugSource = 'agent' | 'review' | 'user' | 'auto-close-warning' | 'manual';
export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface BugVersionLike {
  version: number;
  status: BugStatus;
  prompt: string;
  summary?: string;
  changedFiles?: string[];
  createdAt: string;
  createdBy?: string;
}

export interface BugThreadLike {
  id: string;
  taskId: string;
  title: string;
  status: BugStatus;
  source: BugSource;
  severity: BugSeverity;
  actual?: string;
  expected?: string;
  evidence?: string;
  relatedAreas?: string[];
  versions: BugVersionLike[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateBugThreadInput {
  title: string;
  source?: BugSource;
  severity?: BugSeverity;
  actual?: string;
  expected?: string;
  evidence?: string;
  relatedAreas?: string[];
  prompt?: string;
  summary?: string;
  createdBy?: string;
}

export interface AppendBugVersionInput {
  prompt: string;
  summary?: string;
  changedFiles?: string[];
  createdBy?: string;
}

const UNRESOLVED_BUG_STATUSES = new Set<BugStatus>(['open', 'fixing', 'fixed', 'reopened']);

function nowIso() {
  return new Date().toISOString();
}

function createBugId(taskId: string) {
  return `bug-${taskId}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

function cloneBugs(task: TaskLike) {
  return Array.isArray(task.bugs) ? task.bugs.map((bug) => ({
    ...bug,
    relatedAreas: Array.isArray(bug.relatedAreas) ? [...bug.relatedAreas] : [],
    versions: Array.isArray(bug.versions) ? bug.versions.map((version) => ({
      ...version,
      changedFiles: Array.isArray(version.changedFiles) ? [...version.changedFiles] : [],
    })) : [],
  })) : [];
}

function latestVersionTime(bug: BugThreadLike) {
  const latestVersion = bug.versions[bug.versions.length - 1];
  return new Date(latestVersion?.createdAt || bug.updatedAt || bug.createdAt || 0).getTime();
}

export function isBugUnresolved(bug: BugThreadLike) {
  return UNRESOLVED_BUG_STATUSES.has(bug.status);
}

export function createBugThread<T extends TaskLike>(task: T, input: CreateBugThreadInput): T & { bugs: BugThreadLike[] } {
  const timestamp = nowIso();
  const bug: BugThreadLike = {
    id: createBugId(task.id),
    taskId: task.id,
    title: input.title.trim(),
    status: 'open',
    source: input.source || 'manual',
    severity: input.severity || 'medium',
    actual: input.actual,
    expected: input.expected,
    evidence: input.evidence,
    relatedAreas: Array.isArray(input.relatedAreas) ? input.relatedAreas : [],
    versions: [{
      version: 1,
      status: 'open',
      prompt: input.prompt || input.title.trim(),
      summary: input.summary,
      changedFiles: [],
      createdAt: timestamp,
      createdBy: input.createdBy,
    }],
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  return {
    ...task,
    bugs: [bug, ...cloneBugs(task)],
    updatedAt: timestamp,
  };
}

export function appendBugVersion<T extends TaskLike>(task: T, bugId: string, input: AppendBugVersionInput): T & { bugs: BugThreadLike[] } {
  const timestamp = nowIso();
  const bugs = cloneBugs(task);
  const bugIndex = bugs.findIndex((bug) => bug.id === bugId);
  if (bugIndex === -1) return { ...task, bugs };

  const bug = bugs[bugIndex];
  const nextVersion = Math.max(0, ...bug.versions.map((version) => version.version)) + 1;
  bugs[bugIndex] = {
    ...bug,
    status: bug.status === 'verified' || bug.status === 'archived' ? 'reopened' : bug.status,
    updatedAt: timestamp,
    versions: [
      ...bug.versions,
      {
        version: nextVersion,
        status: 'open',
        prompt: input.prompt,
        summary: input.summary,
        changedFiles: Array.isArray(input.changedFiles) ? input.changedFiles : [],
        createdAt: timestamp,
        createdBy: input.createdBy,
      },
    ],
  };

  return { ...task, bugs: orderBugThreads(bugs), updatedAt: timestamp };
}

export function updateBugStatus<T extends TaskLike>(task: T, bugId: string, status: BugStatus): T & { bugs: BugThreadLike[] } {
  const timestamp = nowIso();
  const bugs = cloneBugs(task);
  const bugIndex = bugs.findIndex((bug) => bug.id === bugId);
  if (bugIndex === -1) return { ...task, bugs };
  bugs[bugIndex] = { ...bugs[bugIndex], status, updatedAt: timestamp };
  return { ...task, bugs: orderBugThreads(bugs), updatedAt: timestamp };
}

export function orderBugThreads(bugs: BugThreadLike[]) {
  return bugs.slice().sort((left, right) => {
    const leftUnresolved = isBugUnresolved(left);
    const rightUnresolved = isBugUnresolved(right);
    if (leftUnresolved !== rightUnresolved) return leftUnresolved ? -1 : 1;
    return latestVersionTime(right) - latestVersionTime(left);
  });
}

export function getBugSummary(task: TaskLike) {
  const orderedBugs = orderBugThreads(cloneBugs(task));
  const unresolvedBugs = orderedBugs.filter(isBugUnresolved);
  return {
    unresolvedBugCount: unresolvedBugs.length,
    latestUnresolvedBug: unresolvedBugs[0] || null,
    orderedBugs,
  };
}

export function getUnfinishedChecklistItems(task: { checklist?: ChecklistItem[] }) {
  return Array.isArray(task.checklist)
    ? task.checklist.filter((item) => !item.completed)
    : [];
}

export function ensureCloseWarningBug<T extends TaskLike & { checklist?: ChecklistItem[] }>(task: T): T & { bugs: BugThreadLike[] } {
  const unfinishedItems = getUnfinishedChecklistItems(task);
  if (unfinishedItems.length === 0) {
    return { ...task, bugs: cloneBugs(task) };
  }

  const actual = `Task was closed with unfinished mini tasks: ${unfinishedItems.map((item) => item.text).join('; ')}`;
  const existingWarning = cloneBugs(task).find((bug) => bug.source === 'auto-close-warning' && isBugUnresolved(bug));
  if (existingWarning) {
    return appendBugVersion(task, existingWarning.id, {
      prompt: `Fix the unfinished mini tasks before treating this task as complete.\n\nUnfinished items:\n${unfinishedItems.map((item) => `- ${item.text}`).join('\n')}`,
      summary: actual,
      createdBy: 'DevFlow',
    });
  }

  return createBugThread(task, {
    title: 'Task closed with unfinished mini tasks',
    source: 'auto-close-warning',
    severity: 'high',
    actual,
    expected: 'All mini tasks should be completed or explicitly converted into follow-up bug versions before closure.',
    evidence: unfinishedItems.map((item) => item.text).join('\n'),
    prompt: `Resolve the unfinished mini tasks for this task.\n\nUnfinished items:\n${unfinishedItems.map((item) => `- ${item.text}`).join('\n')}`,
    summary: actual,
    createdBy: 'DevFlow',
  });
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

export type ChecklistToggleDecision =
  | { ok: true; completed: boolean }
  | { ok: false; code: 'CHECKLIST_TERMINAL_STATE_CONFLICT'; message: string };

export function evaluateChecklistToggleMutation(status: string, completed: boolean): ChecklistToggleDecision {
  const nextCompleted = !completed;
  if (status === 'done' && !nextCompleted) {
    return {
      ok: false,
      code: 'CHECKLIST_TERMINAL_STATE_CONFLICT',
      message: 'Cannot mark a checklist item incomplete while the task is DONE.',
    };
  }
  return { ok: true, completed: nextCompleted };
}

export const RECOVERY_DISPOSITION_CLASSIFICATIONS = ['confirmed-missing', 'recoverable-workspace', 'implemented-metadata-drift', 'superseded', 'follow-up'] as const;
export type RecoveryDispositionClassification = typeof RECOVERY_DISPOSITION_CLASSIFICATIONS[number];
export interface RecoveryDisposition {
  classification: RecoveryDispositionClassification;
  summary: string;
  followUpTaskId?: string;
  workspaceId?: string;
}

const RECOVERY_REQUIRED_BLOCKER_CODES = new Set([
  // Recovery disposition is reserved for unfinished dependency/scope recovery.
  // Checklist, verification, Git publication, and other quality debt may coexist with DONE.
  'CHILD_TASK_BLOCKING',
  'CHILD_EVIDENCE_MISSING',
]);

function boundedOpaqueId(value: unknown, field: string) {
  if (value == null || String(value).trim() === '') return undefined;
  const normalized = String(value).trim();
  if (normalized.length > 200 || /[\\/]/.test(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error(`${field} must be a bounded opaque identifier, not a filesystem path.`);
  }
  return normalized;
}

export function normalizeRecoveryDisposition(value: unknown): RecoveryDisposition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('recoveryDisposition must be an object.');
  const raw = value as Record<string, unknown>;
  const classification = String(raw.classification || '').trim() as RecoveryDispositionClassification;
  if (!RECOVERY_DISPOSITION_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`recoveryDisposition classification must be one of: ${RECOVERY_DISPOSITION_CLASSIFICATIONS.join(', ')}.`);
  }
  const summary = String(raw.summary || '').trim();
  if (!summary) throw new Error('recoveryDisposition summary is required.');
  if (summary.length > 1000) throw new Error('recoveryDisposition summary must be at most 1000 characters.');
  const followUpTaskId = boundedOpaqueId(raw.followUpTaskId, 'followUpTaskId');
  const workspaceId = boundedOpaqueId(raw.workspaceId, 'workspaceId');
  return { classification, summary, ...(followUpTaskId ? { followUpTaskId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}

export function requiresRecoveryDispositionForDone(targetStatus: string, bypassedBlockers: Array<{ code?: string; message?: string; bypassable?: boolean; details?: unknown }> = []) {
  return targetStatus === 'done' && bypassedBlockers.some((blocker) => RECOVERY_REQUIRED_BLOCKER_CODES.has(String(blocker?.code || '')));
}

export type MoveIntent = 'strict' | 'manual';

export interface MoveBlocker {
  code: string;
  message: string;
  bypassable: boolean;
  details?: unknown;
}

export interface MoveEvaluationInput {
  intent?: MoveIntent;
  manualOverride?: boolean;
  softBlockers?: MoveBlocker[];
  hardBlockers?: MoveBlocker[];
}

export interface MoveDecision {
  allowed: boolean;
  outcome: 'allowed' | 'confirmation-required' | 'blocked' | 'hard-blocked';
  blockers: MoveBlocker[];
  bypassedBlockers: MoveBlocker[];
}

export function evaluateMove(target: TaskLike, targetStatus: string): { allowed: true };
export function evaluateMove(input: MoveEvaluationInput): MoveDecision;
export function evaluateMove(input: MoveEvaluationInput | TaskLike, targetStatus?: string): MoveDecision | { allowed: true } {
  if (typeof targetStatus === 'string') return { allowed: true };
  const decisionInput = input as MoveEvaluationInput;
  const intent: MoveIntent = decisionInput.intent === 'manual' ? 'manual' : 'strict';
  const softBlockers = Array.isArray(decisionInput.softBlockers) ? decisionInput.softBlockers : [];
  const hardBlockers = Array.isArray(decisionInput.hardBlockers) ? decisionInput.hardBlockers : [];

  if (hardBlockers.length > 0) {
    return { allowed: false, outcome: 'hard-blocked', blockers: hardBlockers, bypassedBlockers: [] };
  }
  if (softBlockers.length === 0) {
    return { allowed: true, outcome: 'allowed', blockers: [], bypassedBlockers: [] };
  }
  if (intent !== 'manual') {
    return { allowed: false, outcome: 'blocked', blockers: softBlockers, bypassedBlockers: [] };
  }
  if (!decisionInput.manualOverride) {
    return { allowed: false, outcome: 'confirmation-required', blockers: softBlockers, bypassedBlockers: [] };
  }
  return { allowed: true, outcome: 'allowed', blockers: [], bypassedBlockers: softBlockers };
}
