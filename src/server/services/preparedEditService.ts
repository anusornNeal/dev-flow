import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { AppState } from '../types';
import { getFileRevision } from './localFileService';
import {
  applyPreparedSafeEditFile,
  prepareSafeEditFile,
  type PreparedSafeEditFile,
  type SafeEditResult,
} from './safeEditFileService';

const DEFAULT_PLAN_TTL_MS = 60_000;
const MAX_PLAN_TTL_MS = 5 * 60_000;
const MAX_PLANS = 128;

type StoredEditPlan = {
  editPlanId: string;
  createdAtMs: number;
  expiresAtMs: number;
  consumed: boolean;
  prepared: PreparedSafeEditFile[];
};

export type PreparedEditPlanResult = {
  ok: boolean;
  changed: boolean;
  editPlanId?: string;
  createdAt?: string;
  expiresAt?: string;
  consumed?: boolean;
  files: SafeEditResult[];
  code?: 'INVALID_ARGS' | 'EDIT_PLAN_NOT_FOUND' | 'EDIT_PLAN_EXPIRED' | 'EDIT_PLAN_CONSUMED' | 'EDIT_PLAN_STALE' | 'EDIT_PLAN_APPLY_FAILED';
  message?: string;
};

const plans = new Map<string, StoredEditPlan>();

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
      code: 'INVALID_ARGS',
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
    consumed: false,
    prepared,
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

export function applyPreparedEditPlan(args: { editPlanId?: string }): PreparedEditPlanResult {
  const editPlanId = String(args.editPlanId || '').trim();
  if (!editPlanId) {
    return { ok: false, changed: false, files: [], code: 'INVALID_ARGS', message: 'editPlanId is required.' };
  }

  const plan = plans.get(editPlanId);
  if (!plan) {
    return { ok: false, changed: false, files: [], code: 'EDIT_PLAN_NOT_FOUND', message: `Prepared edit plan '${editPlanId}' was not found.` };
  }
  if (Date.now() >= plan.expiresAtMs) {
    plans.delete(editPlanId);
    return { ok: false, changed: false, files: plan.prepared.map((entry) => entry.result), code: 'EDIT_PLAN_EXPIRED', message: `Prepared edit plan '${editPlanId}' expired.` };
  }
  if (plan.consumed) {
    return { ok: false, changed: false, files: plan.prepared.map((entry) => entry.result), code: 'EDIT_PLAN_CONSUMED', message: `Prepared edit plan '${editPlanId}' has already been applied.` };
  }

  for (const prepared of plan.prepared) {
    if (!prepared.ok || !prepared.result.revisionBefore) continue;
    let current;
    try {
      current = getFileRevision(prepared.targetPath);
    } catch {
      return { ok: false, changed: false, files: plan.prepared.map((entry) => entry.result), code: 'EDIT_PLAN_STALE', message: `File '${prepared.result.filePath}' changed or disappeared after plan preparation.` };
    }
    if (current.sha256 !== prepared.result.revisionBefore.sha256) {
      return { ok: false, changed: false, files: plan.prepared.map((entry) => entry.result), code: 'EDIT_PLAN_STALE', message: `File '${prepared.result.filePath}' changed after plan preparation.` };
    }
  }

  plan.consumed = true;
  const applied: SafeEditResult[] = [];
  const written: Extract<PreparedSafeEditFile, { ok: true }>[] = [];

  for (const prepared of plan.prepared) {
    const result = applyPreparedSafeEditFile(prepared);
    applied.push(result);
    if (!result.ok) {
      for (const prior of written) {
        fs.writeFileSync(prior.targetPath, prior.before, 'utf8');
      }
      return {
        ok: false,
        changed: false,
        editPlanId,
        consumed: true,
        files: applied,
        code: 'EDIT_PLAN_APPLY_FAILED',
        message: result.error?.message || 'Prepared edit plan failed during apply and prior writes were restored.',
      };
    }
    if (prepared.ok && result.changed) written.push(prepared);
  }

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
