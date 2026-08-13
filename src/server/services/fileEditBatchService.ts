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

function rollbackWrittenFiles(written: PreparedSafeEditFile[]) {
  const failures: Array<{ filePath: string; message: string }> = [];
  for (const prior of [...written].reverse()) {
    if (!prior.ok) continue;
    try {
      fs.writeFileSync(prior.targetPath, prior.before, 'utf8');
    } catch (error) {
      failures.push({ filePath: prior.result.filePath, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return failures;
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

  const plannedChangedPaths = planned.filter((result) => result.ok && result.changed).map((result) => result.filePath);
  if (plannedChangedPaths.length > 0 && typeof args.__authorizeOwnedChanges === 'function') {
    args.__authorizeOwnedChanges(plannedChangedPaths);
  }

  const applied: SafeEditResult[] = [];
  const written: PreparedSafeEditFile[] = [];
  for (const preparedFile of prepared) {
    const result = applyPreparedSafeEditFile(preparedFile);
    applied.push(result);
    if (!result.ok) {
      const rollbackFailures = rollbackWrittenFiles(written);
      return {
        ok: false,
        dryRun: false,
        changed: false,
        preflightReused: true,
        files: applied,
        errors: [
          { filePath: result.filePath, code: result.error?.code, message: result.error?.message || 'Edit failed during apply; restored previous file contents.' },
          ...rollbackFailures.map((entry) => ({ filePath: entry.filePath, code: 'ROLLBACK_FAILED', message: entry.message })),
        ],
      };
    }
    if (result.changed) written.push(preparedFile);
  }

  const changedPaths = applied.filter((result) => result.ok && result.changed).map((result) => result.filePath);
  if (changedPaths.length > 0 && typeof args.__recordOwnedChanges === 'function') {
    try {
      args.__recordOwnedChanges(changedPaths);
    } catch (error) {
      const rollbackFailures = rollbackWrittenFiles(written);
      const recoveryRequired = rollbackFailures.length > 0;
      return {
        ok: false,
        dryRun: false,
        changed: recoveryRequired,
        preflightReused: true,
        files: applied,
        errors: [{
          filePath: changedPaths.join(', '),
          code: recoveryRequired ? 'OWNERSHIP_ROLLBACK_FAILED' : 'OWNERSHIP_RECORD_FAILED',
          message: recoveryRequired
            ? `Ownership persistence failed and filesystem rollback was incomplete: ${rollbackFailures.map((entry) => `${entry.filePath}: ${entry.message}`).join('; ')}`
            : `Ownership persistence failed; file writes were rolled back: ${error instanceof Error ? error.message : String(error)}`,
        }],
      };
    }
  }

  return { ok: true, dryRun: false, changed: applied.some((result) => result.changed), preflightReused: true, files: applied };
}
