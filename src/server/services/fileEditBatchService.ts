import fs from 'node:fs';
import type { AppState } from '../types';
import { applyPreparedSafeEditFile, prepareSafeEditFile, type PreparedSafeEditFile, type SafeEditResult } from './safeEditFileService';

export type FileEditBatchResult = {
  ok: boolean;
  dryRun: boolean;
  changed: boolean;
  preflightReused?: boolean;
  files: SafeEditResult[];
  errors?: Array<{ filePath: string; code?: string; message: string }>;
};

function filePathOf(fileArgs: Record<string, any>) {
  return String(fileArgs.filePath || fileArgs.path || '').trim();
}

function normalizeArgs(args: Record<string, any>, fileArgs: Record<string, any>, mode: 'dry-run' | 'apply') {
  return { ...args, ...fileArgs, mode, filePath: filePathOf(fileArgs), edits: fileArgs.edits || fileArgs.operations };
}

function invalidResult(dryRun: boolean, filePath: string, code: string, message: string): FileEditBatchResult {
  return { ok: false, dryRun, changed: false, files: [], errors: [{ filePath, code, message }] };
}

export function editFilesBatch(state: AppState, args: Record<string, any>): FileEditBatchResult {
  const dryRun = args.mode !== 'apply';
  const files = Array.isArray(args.files) ? args.files : [];
  if (files.length === 0) return invalidResult(dryRun, '', 'INVALID_ARGS', 'files must contain at least one file edit.');

  const seen = new Set<string>();
  for (const fileArgs of files) {
    const filePath = filePathOf(fileArgs || {});
    if (!filePath) return invalidResult(dryRun, '', 'INVALID_ARGS', 'Each file edit requires filePath or path.');
    if (seen.has(filePath)) return invalidResult(dryRun, filePath, 'DUPLICATE_FILE', 'Batch edits do not allow duplicate file paths.');
    seen.add(filePath);
  }

  const prepared = files.map((fileArgs: Record<string, any>) => prepareSafeEditFile(state, normalizeArgs(args, fileArgs, 'dry-run')));
  const planned = prepared.map((entry) => entry.result);
  const failed = planned.filter((result) => !result.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      dryRun,
      changed: false,
      preflightReused: false,
      files: planned,
      errors: failed.map((result) => ({ filePath: result.filePath, code: result.error?.code, message: result.error?.message || 'Edit failed.' })),
    };
  }
  if (dryRun) return { ok: true, dryRun: true, changed: planned.some((result) => result.changed), preflightReused: false, files: planned };

  const applied: SafeEditResult[] = [];
  const written: PreparedSafeEditFile[] = [];
  for (const preparedFile of prepared) {
    const result = applyPreparedSafeEditFile(preparedFile);
    applied.push(result);
    if (!result.ok) {
      for (const prior of written) {
        if (prior.ok) fs.writeFileSync(prior.targetPath, prior.before, 'utf8');
      }
      return {
        ok: false,
        dryRun: false,
        changed: false,
        preflightReused: true,
        files: applied,
        errors: [{ filePath: result.filePath, code: result.error?.code, message: result.error?.message || 'Edit failed during apply; restored previous file contents.' }],
      };
    }
    if (result.changed) written.push(preparedFile);
  }

  return { ok: true, dryRun: false, changed: applied.some((result) => result.changed), preflightReused: true, files: applied };
}
