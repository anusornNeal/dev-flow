import fs from 'node:fs';
import type { AppState } from '../types';
import { resolveProjectRoot, resolveSafePath } from './localFileService';
import { safeEditFile, type SafeEditResult } from './safeEditFileService';

export type FileEditBatchResult = {
  ok: boolean;
  dryRun: boolean;
  changed: boolean;
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

  const planned = files.map((fileArgs: Record<string, any>) => safeEditFile(state, normalizeArgs(args, fileArgs, 'dry-run')));
  const failed = planned.filter((result) => !result.ok);
  if (failed.length > 0) {
    return {
      ok: false,
      dryRun,
      changed: false,
      files: planned,
      errors: failed.map((result) => ({ filePath: result.filePath, code: result.error?.code, message: result.error?.message || 'Edit failed.' })),
    };
  }
  if (dryRun) return { ok: true, dryRun: true, changed: planned.some((result) => result.changed), files: planned };

  const root = resolveProjectRoot(state, args);
  const backups = new Map<string, string>();
  for (const fileArgs of files) {
    const targetPath = resolveSafePath(root, filePathOf(fileArgs));
    backups.set(targetPath, fs.readFileSync(targetPath, 'utf8'));
  }

  const applied: SafeEditResult[] = [];
  for (const fileArgs of files) {
    const result = safeEditFile(state, normalizeArgs(args, fileArgs, 'apply'));
    applied.push(result);
    if (!result.ok) {
      for (const [targetPath, content] of backups) fs.writeFileSync(targetPath, content, 'utf8');
      return { ok: false, dryRun: false, changed: false, files: applied, errors: [{ filePath: result.filePath, code: result.error?.code, message: result.error?.message || 'Edit failed during apply; restored previous file contents.' }] };
    }
  }

  return { ok: true, dryRun: false, changed: applied.some((result) => result.changed), files: applied };
}
