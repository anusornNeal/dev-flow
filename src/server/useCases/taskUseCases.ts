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
