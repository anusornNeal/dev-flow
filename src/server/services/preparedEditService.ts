import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppState } from '../types';
import { getFileRevision } from './localFileService';
import { invalidateRepoReadCaches } from './repoCacheInvalidationService';
import { getToolRecoveryPolicy, type ToolRecoveryCategory, type ToolRecoveryStrategy } from './toolRecoveryPolicy.js';
import {
  applyPreparedSafeEditFile,
  prepareSafeEditFile,
  type PreparedSafeEditFile,
  type SafeEditResult,
} from './safeEditFileService';
import { getActiveTaskExecutionSessionForWorkspace } from './executionSessionService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';

const DEFAULT_PLAN_TTL_MS = 180_000;
const MAX_PLAN_TTL_MS = 300_000;
const MAX_PLANS = 128;

type PreparedExecutionProvenance = {
  workspaceId: string;
  executionSessionId: string;
  taskId: string;
  projectId: string;
};

type StoredEditPlan = {
  editPlanId: string;
  createdAtMs: number;
  expiresAtMs: number;
  status: 'prepared' | 'applying' | 'consumed';
  prepared: PreparedSafeEditFile[];
  sourceArgs: Record<string, any>;
  executionProvenance: PreparedExecutionProvenance | null;
};

export type PreparedEditPlanResult = {
  ok: boolean;
  changed: boolean;
  editPlanId?: string;
  createdAt?: string;
  expiresAt?: string;
  consumed?: boolean;
  files: SafeEditResult[];
  code?: string;
  message?: string;
  recovery?: {
    action: 're-read' | 're-prepare' | 'inspect-result';
    retrySamePayload: false;
    guidance: string;
    category: ToolRecoveryCategory;
    strategy: ToolRecoveryStrategy;
    autoApply: boolean;
    requiresFreshSource: boolean;
    requiresFreshPreview: boolean;
  };
  rollback?: {
    attempted: string[];
    restored: string[];
    conflicts: string[];
    failures: Array<{ filePath: string; message: string }>;
  };
};

const plans = new Map<string, StoredEditPlan>();

type PreparedEditTestHooks = {
  beforeApplyFile?: (context: { index: number; editPlanId: string; prepared: PreparedSafeEditFile }) => void;
  rollbackWrite?: (targetPath: string, content: string) => void;
};

let testHooks: PreparedEditTestHooks | null = null;

export function __setPreparedEditTestHooks(hooks: PreparedEditTestHooks | null) {
  testHooks = hooks;
}

function filePathOf(fileArgs: Record<string, any>) {
  return String(fileArgs?.filePath || fileArgs?.path || '').trim();
}

function normalizeFileArgs(args: Record<string, any>, fileArgs: Record<string, any>) {
  return {
    ...args,
    ...fileArgs,
    mode: 'dry-run',
    filePath: filePathOf(fileArgs),
    edits: fileArgs.edits || fileArgs.operations,
  };
}

function recoverySourceArgs(args: Record<string, any>) {
  const copy: Record<string, any> = { ...args };
  delete copy.editPlanId;
  delete copy.mode;
  copy.files = (Array.isArray(args.files) ? args.files : []).map((fileArgs: Record<string, any>) => {
    const file = { ...fileArgs };
    delete file.expectedRevision;
    delete file.fileRevision;
    delete file.expectedContentHash;
    delete file.expectedSha256;
    return file;
  });
  return copy;
}

function capturePreparedExecutionProvenance(args: Record<string, any>): PreparedExecutionProvenance | null {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!workspaceId) return null;
  const session = getActiveTaskExecutionSessionForWorkspace(workspaceId);
  if (!session?.taskId) return null;
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace || workspace.projectId !== session.projectId) {
    throw Object.assign(new Error(`Workspace '${workspaceId}' is not bound to the active task execution session.`), { code: 'EDIT_PLAN_STALE' });
  }
  return {
    workspaceId,
    executionSessionId: session.id,
    taskId: session.taskId,
    projectId: session.projectId,
  };
}

function preparedExecutionProvenanceError(provenance: PreparedExecutionProvenance | null) {
  if (!provenance) return null;
  try {
    const workspace = resolveSessionWorkspace(provenance.workspaceId);
    const session = getActiveTaskExecutionSessionForWorkspace(provenance.workspaceId);
    if (
      !workspace
      || !session?.taskId
      || workspace.projectId !== provenance.projectId
      || session.id !== provenance.executionSessionId
      || session.taskId !== provenance.taskId
      || session.projectId !== provenance.projectId
    ) {
      return 'Prepared edit execution/workspace provenance is no longer current.';
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function getPreparedEditRecoveryArgs(editPlanId: string) {
  const plan = plans.get(String(editPlanId || '').trim());
  return plan ? recoverySourceArgs(plan.sourceArgs) : null;
}

function clampTtl(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_PLAN_TTL_MS;
  return Math.max(1_000, Math.min(MAX_PLAN_TTL_MS, Math.floor(parsed)));
}

function prunePlans(now = Date.now()) {
  for (const [id, plan] of plans) {
    if (plan.expiresAtMs <= now) plans.delete(id);
  }
  while (plans.size >= MAX_PLANS) {
    const oldest = plans.keys().next().value;
    if (!oldest) break;
    plans.delete(oldest);
  }
}

export function clearPreparedEditPlans() {
  const count = plans.size;
  plans.clear();
  return count;
}

export function prepareEditPlan(state: AppState, args: Record<string, any>): PreparedEditPlanResult {
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length === 0) {
    return { ok: false, changed: false, files: [], code: 'INVALID_ARGS', message: 'files must contain at least one file edit.' };
  }

  const seen = new Set<string>();
  for (const fileArgs of files) {
    const filePath = filePathOf(fileArgs);
    if (!filePath) {
      return { ok: false, changed: false, files: [], code: 'INVALID_ARGS', message: 'Each file edit requires filePath or path.' };
    }
    if (seen.has(filePath)) {
      return { ok: false, changed: false, files: [], code: 'INVALID_ARGS', message: `Duplicate file path '${filePath}' is not allowed in one edit plan.` };
    }
    seen.add(filePath);
  }

  const prepared = files.map((fileArgs: Record<string, any>) => prepareSafeEditFile(state, normalizeFileArgs(args, fileArgs)));
  const results = prepared.map((entry) => entry.result);
  const failed = results.find((result) => !result.ok);
  if (failed) {
    return {
      ok: false,
      changed: false,
      files: results,
      code: failed.error?.code || 'INVALID_ARGS',
      message: failed.error?.message || 'Edit plan preflight failed.',
    };
  }

  const now = Date.now();
  prunePlans(now);
  const ttlMs = clampTtl(args.ttlMs);
  const editPlanId = `edit-plan-${randomUUID()}`;
  const stored: StoredEditPlan = {
    editPlanId,
    createdAtMs: now,
    expiresAtMs: now + ttlMs,
    status: 'prepared',
    prepared,
    sourceArgs: recoverySourceArgs(args),
    executionProvenance: capturePreparedExecutionProvenance(args),
  };
  plans.set(editPlanId, stored);

  return {
    ok: true,
    changed: results.some((result) => result.changed),
    editPlanId,
    createdAt: new Date(stored.createdAtMs).toISOString(),
    expiresAt: new Date(stored.expiresAtMs).toISOString(),
    consumed: false,
    files: results,
  };
}

export function refreshPreparedEditPreviewForRecovery(state: AppState, args: Record<string, any>) {
  const storedArgs = args?.editPlanId ? getPreparedEditRecoveryArgs(String(args.editPlanId)) : null;
  const source = storedArgs || (args?.recoveryPrepareArgs && typeof args.recoveryPrepareArgs === 'object' ? args.recoveryPrepareArgs : args);
  const prepareArgs = recoverySourceArgs(source);
  const preview = prepareEditPlan(state, prepareArgs);
  if (!preview.ok) {
    const error = Object.assign(new Error(preview.message || 'Could not prepare a fresh edit preview.'), { code: preview.code || 'EDIT_PREVIEW_FAILED' });
    throw error;
  }
  return {
    editPlanId: preview.editPlanId,
    preview,
    materiallyChanged: preview.changed === true,
  };
}

function rollbackWrittenFiles(written: Extract<PreparedSafeEditFile, { ok: true }>[]) {
  const rollback = {
    attempted: [] as string[],
    restored: [] as string[],
    conflicts: [] as string[],
    failures: [] as Array<{ filePath: string; message: string }>,
  };

  for (const prior of [...written].reverse()) {
    const filePath = prior.result.filePath;
    rollback.attempted.push(filePath);
    try {
      const current = fs.readFileSync(prior.targetPath, 'utf8');
      if (current !== prior.after) {
        rollback.conflicts.push(filePath);
        continue;
      }
      if (testHooks?.rollbackWrite) {
        testHooks.rollbackWrite(prior.targetPath, prior.before);
      } else {
        fs.writeFileSync(prior.targetPath, prior.before, 'utf8');
      }
      invalidateRepoReadCaches(prior.root, 'preparedEditRollback', { paths: [filePath] });
      rollback.restored.push(filePath);
    } catch (error) {
      rollback.failures.push({
        filePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return rollback;
}

function planRecovery(code: string, action: 're-read' | 're-prepare' | 'inspect-result', guidance: string) {
  const policy = getToolRecoveryPolicy(code);
  return {
    action,
    retrySamePayload: false as const,
    guidance,
    category: policy.category,
    strategy: policy.strategy,
    autoApply: policy.autoApply,
    requiresFreshSource: policy.requiresFreshSource,
    requiresFreshPreview: policy.requiresFreshPreview,
  };
}

export function applyPreparedEditPlan(
  args: { editPlanId?: string },
  options: {
    authorizeOwnedChanges?: (paths: string[]) => void;
    recordOwnedChanges?: (paths: string[]) => void;
  } = {},
): PreparedEditPlanResult {
  const editPlanId = String(args.editPlanId || '').trim();
  if (!editPlanId) {
    return { ok: false, changed: false, files: [], code: 'INVALID_ARGS', message: 'editPlanId is required.' };
  }

  const plan = plans.get(editPlanId);
  if (!plan) {
    return {
      ok: false,
      changed: false,
      files: [],
      code: 'EDIT_PLAN_NOT_FOUND',
      message: `Prepared edit plan '${editPlanId}' was not found. Re-prepare the edit instead of retrying the same plan id.`,
      recovery: planRecovery('EDIT_PLAN_NOT_FOUND', 're-prepare', 'Prepare a new edit plan. Do not retry the same plan id.'),
    };
  }
  if (Date.now() >= plan.expiresAtMs) {
    plans.delete(editPlanId);
    return {
      ok: false,
      changed: false,
      files: plan.prepared.map((entry) => entry.result),
      code: 'EDIT_PLAN_EXPIRED',
      message: `Prepared edit plan '${editPlanId}' expired. Re-read/re-prepare the edit instead of retrying this plan id.`,
      recovery: planRecovery('EDIT_PLAN_EXPIRED', 're-prepare', 'Prepare a new edit plan; if its source fileRef has also expired, re-read that file first.'),
    };
  }
  if (plan.status !== 'prepared') {
    return {
      ok: false,
      changed: false,
      consumed: true,
      files: plan.prepared.map((entry) => entry.result),
      code: 'EDIT_PLAN_CONSUMED',
      message: `Prepared edit plan '${editPlanId}' has already been consumed.`,
      recovery: planRecovery('EDIT_PLAN_CONSUMED', 'inspect-result', 'Do not replay or automatically re-prepare a consumed plan. Inspect the prior apply result or current diff before deciding the next edit.'),
    };
  }

  const provenanceError = preparedExecutionProvenanceError(plan.executionProvenance);
  if (provenanceError) {
    plan.status = 'consumed';
    return {
      ok: false,
      changed: false,
      editPlanId,
      consumed: true,
      files: plan.prepared.map((entry) => entry.result),
      code: 'EDIT_PLAN_STALE',
      message: `${provenanceError} Re-read and prepare a new plan in the current execution workspace.`,
      recovery: planRecovery('EDIT_PLAN_STALE', 're-read', 'Re-read from the current task execution workspace and prepare a new plan. The stale plan is consumed.'),
    };
  }

  const plannedChangedPaths = plan.prepared
    .map((entry) => entry.result)
    .filter((result) => result.ok && result.changed)
    .map((result) => result.filePath);
  if (plannedChangedPaths.length > 0 && options.authorizeOwnedChanges) {
    options.authorizeOwnedChanges(plannedChangedPaths);
  }

  plan.status = 'applying';
  const sourceFiles = plan.prepared.map((entry) => entry.result);
  for (const prepared of plan.prepared) {
    if (!prepared.ok || !prepared.result.revisionBefore) continue;
    let current;
    try {
      current = getFileRevision(prepared.targetPath);
    } catch {
      plan.status = 'consumed';
      return {
        ok: false,
        changed: false,
        editPlanId,
        consumed: true,
        files: sourceFiles,
        code: 'EDIT_PLAN_STALE',
        message: `File '${prepared.result.filePath}' changed or disappeared after plan preparation. Re-read and prepare again.`,
        recovery: planRecovery('EDIT_PLAN_STALE', 're-read', 'Re-read the changed file and prepare a new plan. The stale plan is consumed.'),
      };
    }
    if (current.sha256 !== prepared.result.revisionBefore.sha256) {
      plan.status = 'consumed';
      return {
        ok: false,
        changed: false,
        editPlanId,
        consumed: true,
        files: sourceFiles,
        code: 'EDIT_PLAN_STALE',
        message: `File '${prepared.result.filePath}' changed after plan preparation. Re-read and prepare again.`,
        recovery: planRecovery('EDIT_PLAN_STALE', 're-read', 'Re-read the changed file and prepare a new plan. The stale plan is consumed.'),
      };
    }
  }

  const applied: SafeEditResult[] = [];
  const written: Extract<PreparedSafeEditFile, { ok: true }>[] = [];

  for (let index = 0; index < plan.prepared.length; index += 1) {
    const prepared = plan.prepared[index];
    let result: SafeEditResult;
    try {
      testHooks?.beforeApplyFile?.({ index, editPlanId, prepared });
      result = applyPreparedSafeEditFile(prepared);
    } catch (error) {
      const rollback = rollbackWrittenFiles(written);
      plan.status = 'consumed';
      return {
        ok: false,
        changed: false,
        editPlanId,
        consumed: true,
        files: applied,
        code: 'EDIT_PLAN_APPLY_FAILED',
        message: error instanceof Error ? error.message : String(error),
        rollback,
      };
    }

    applied.push(result);
    if (!result.ok) {
      const rollback = rollbackWrittenFiles(written);
      plan.status = 'consumed';
      return {
        ok: false,
        changed: false,
        editPlanId,
        consumed: true,
        files: applied,
        code: 'EDIT_PLAN_APPLY_FAILED',
        message: result.error?.message || 'Prepared edit plan failed during apply.',
        rollback,
      };
    }
    if (prepared.ok && result.changed) written.push(prepared);
  }

  const changedPaths = applied.filter((result) => result.ok && result.changed).map((result) => result.filePath);
  if (changedPaths.length > 0 && options.recordOwnedChanges) {
    try {
      options.recordOwnedChanges(changedPaths);
    } catch (error) {
      const rollback = rollbackWrittenFiles(written);
      plan.status = 'consumed';
      const recoveryRequired = rollback.failures.length > 0 || rollback.conflicts.length > 0;
      return {
        ok: false,
        changed: recoveryRequired,
        editPlanId,
        consumed: true,
        files: applied,
        code: recoveryRequired ? 'EDIT_PLAN_RECOVERY_REQUIRED' : 'EDIT_PLAN_OWNERSHIP_FAILED',
        message: recoveryRequired
          ? 'Ownership persistence failed and prepared-edit rollback could not fully restore the workspace.'
          : `Ownership persistence failed; prepared writes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
        rollback,
      };
    }
  }

  plan.status = 'consumed';
  return {
    ok: true,
    changed: applied.some((result) => result.changed),
    editPlanId,
    createdAt: new Date(plan.createdAtMs).toISOString(),
    expiresAt: new Date(plan.expiresAtMs).toISOString(),
    consumed: true,
    files: applied,
  };
}
