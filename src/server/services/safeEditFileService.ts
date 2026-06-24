import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppState } from '../types';
import { assertFileRevisionMatches, getFileRevision, resolveProjectRoot, resolveSafePath, type FileRevision } from './localFileService';

export type SafeEditOperationType = 'replace' | 'insert_before' | 'insert_after' | 'delete_between';

export type SafeEditOperation = {
  type: SafeEditOperationType;
  find?: string;
  replaceWith?: string;
  content?: string;
  start?: string;
  end?: string;
  occurrence?: number;
};

type SafeEditErrorCode =
  | 'INVALID_ARGS'
  | 'FILE_NOT_FOUND'
  | 'FILE_TOO_LARGE'
  | 'PAYLOAD_TOO_LARGE'
  | 'NO_MATCH'
  | 'AMBIGUOUS_MATCH'
  | 'INVALID_OPERATION'
  | 'UNSAFE_PATH'
  | 'CONTENT_CHANGED'
  | 'WRITE_FAILED';

type NewlineStyle = 'lf' | 'crlf' | 'mixed' | 'none';

export type SafeEditResult = {
  ok: boolean;
  dryRun: boolean;
  filePath: string;
  changed: boolean;
  changedLines: number;
  operations: number;
  bytesBefore: number;
  bytesAfter: number;
  revisionBefore?: FileRevision;
  revisionAfter?: FileRevision;
  preview?: {
    beforeExcerpt: string;
    afterExcerpt: string;
  };
  diagnostics?: {
    newlineStyle: NewlineStyle;
    matchedWithNormalizedNewlines: boolean;
    hints: string[];
  };
  error?: {
    code: SafeEditErrorCode;
    message: string;
    operationIndex?: number;
  };
};

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectNewlineStyle(value: string): NewlineStyle {
  const crlf = (value.match(/\r\n/g) || []).length;
  const lf = (value.match(/(?<!\r)\n/g) || []).length;
  const cr = (value.match(/\r(?!\n)/g) || []).length;
  if (crlf === 0 && lf === 0 && cr === 0) return 'none';
  if (crlf > 0 && lf === 0 && cr === 0) return 'crlf';
  if (crlf === 0 && cr === 0) return 'lf';
  return 'mixed';
}

function preferredNewline(style: NewlineStyle): '\n' | '\r\n' {
  return style === 'crlf' ? '\r\n' : '\n';
}

function restoreNewlines(value: string, style: NewlineStyle): string {
  const normalized = normalizeNewlines(value);
  const newline = preferredNewline(style);
  return newline === '\n' ? normalized : normalized.replace(/\n/g, newline);
}

function normalizeOperation(op: SafeEditOperation): SafeEditOperation {
  return {
    ...op,
    find: op.find === undefined ? undefined : normalizeNewlines(String(op.find)),
    replaceWith: op.replaceWith === undefined ? undefined : normalizeNewlines(String(op.replaceWith)),
    content: op.content === undefined ? undefined : normalizeNewlines(String(op.content)),
    start: op.start === undefined ? undefined : normalizeNewlines(String(op.start)),
    end: op.end === undefined ? undefined : normalizeNewlines(String(op.end)),
  };
}

function operationUsedNewlineNormalization(op: SafeEditOperation): boolean {
  return [op.find, op.replaceWith, op.content, op.start, op.end]
    .filter((value): value is string => typeof value === 'string')
    .some((value) => value !== normalizeNewlines(value));
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const next = haystack.indexOf(needle, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + needle.length;
  }
}

function countChangedLines(before: string, after: string): number {
  if (before === after) return 0;
  const beforeLines = normalizeNewlines(before).split('\n');
  const afterLines = normalizeNewlines(after).split('\n');
  const total = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;
  for (let i = 0; i < total; i += 1) {
    if (beforeLines[i] !== afterLines[i]) changed += 1;
  }
  return changed;
}

function excerpt(value: string): string {
  const max = 1200;
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...<truncated ${value.length - max} chars>`;
}

function fail(args: { dryRun: boolean; filePath: string; code: SafeEditErrorCode; message: string; operationIndex?: number; diagnostics?: SafeEditResult['diagnostics'] }): SafeEditResult {
  return {
    ok: false,
    dryRun: args.dryRun,
    filePath: args.filePath,
    changed: false,
    changedLines: 0,
    operations: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    diagnostics: args.diagnostics,
    error: {
      code: args.code,
      message: args.message,
      operationIndex: args.operationIndex,
    },
  };
}

function requireSingleMatch(
  current: string,
  marker: string | undefined,
  operationIndex: number,
  occurrence?: number,
): { ok: true; index: number } | { ok: false; code: 'NO_MATCH' | 'AMBIGUOUS_MATCH'; message: string } {
  if (!marker) {
    return { ok: false, code: 'NO_MATCH', message: 'Anchor text is required.' };
  }
  const count = countOccurrences(current, marker);
  if (count === 0) {
    return { ok: false, code: 'NO_MATCH', message: `No match for operation ${operationIndex}.` };
  }
  if (occurrence !== undefined) {
    if (occurrence < 1 || occurrence > count) {
      return { ok: false, code: 'NO_MATCH', message: `Occurrence ${occurrence} not found for operation ${operationIndex}. Only ${count} matches found.` };
    }
    let offset = 0;
    for (let i = 1; i < occurrence; i++) {
      offset = current.indexOf(marker, offset) + marker.length;
    }
    return { ok: true, index: current.indexOf(marker, offset) };
  }
  if (count > 1) {
    return { ok: false, code: 'AMBIGUOUS_MATCH', message: `Anchor matched ${count} times for operation ${operationIndex}.` };
  }
  return { ok: true, index: current.indexOf(marker) };
}

function applyOperation(current: string, op: SafeEditOperation, index: number): { ok: true; value: string } | { ok: false; code: SafeEditErrorCode; message: string } {
  if (!op || typeof op !== 'object') {
    return { ok: false, code: 'INVALID_OPERATION', message: `Operation ${index} must be an object.` };
  }

  if (op.type === 'replace') {
    const match = requireSingleMatch(current, op.find, index, op.occurrence);
    if (match.ok === false) return { ok: false, code: match.code, message: match.message };
    return { ok: true, value: `${current.slice(0, match.index)}${op.replaceWith ?? ''}${current.slice(match.index + String(op.find).length)}` };
  }

  if (op.type === 'insert_before') {
    const match = requireSingleMatch(current, op.find, index, op.occurrence);
    if (match.ok === false) return { ok: false, code: match.code, message: match.message };
    return { ok: true, value: `${current.slice(0, match.index)}${op.content ?? ''}${current.slice(match.index)}` };
  }

  if (op.type === 'insert_after') {
    const match = requireSingleMatch(current, op.find, index, op.occurrence);
    if (match.ok === false) return { ok: false, code: match.code, message: match.message };
    const insertAt = match.index + String(op.find).length;
    return { ok: true, value: `${current.slice(0, insertAt)}${op.content ?? ''}${current.slice(insertAt)}` };
  }

  if (op.type === 'delete_between') {
    const start = requireSingleMatch(current, op.start, index, op.occurrence);
    if (start.ok === false) return { ok: false, code: start.code, message: start.message };
    const afterStart = start.index + String(op.start).length;
    const rest = current.slice(afterStart);
    const end = requireSingleMatch(rest, op.end, index);
    if (end.ok === false) return { ok: false, code: end.code, message: end.message };
    const deleteEnd = afterStart + end.index;
    return { ok: true, value: `${current.slice(0, afterStart)}${current.slice(deleteEnd)}` };
  }

  return { ok: false, code: 'INVALID_OPERATION', message: `Unsupported operation type for operation ${index}.` };
}

export function safeEditFile(state: AppState, args: Record<string, any>): SafeEditResult {
  const dryRun = args.mode !== 'apply';
  const filePath = String(args.filePath || args.path || '');
  if (!filePath) {
    return fail({ dryRun, filePath, code: 'INVALID_ARGS', message: 'filePath is required.' });
  }

  const operations = Array.isArray(args.edits) ? args.edits : Array.isArray(args.operations) ? args.operations : [];
  if (operations.length === 0) {
    return fail({ dryRun, filePath, code: 'INVALID_ARGS', message: 'At least one edit operation is required.' });
  }

  const maxPayloadBytes = Math.min(Number(args.maxPayloadBytes || DEFAULT_MAX_PAYLOAD_BYTES), 1024 * 1024);
  const payloadBytes = byteLength(JSON.stringify(operations));
  if (payloadBytes > maxPayloadBytes) {
    return fail({ dryRun, filePath, code: 'PAYLOAD_TOO_LARGE', message: `Edit payload is ${payloadBytes} bytes; limit is ${maxPayloadBytes}.` });
  }

  const root = resolveProjectRoot(state, args);
  let targetPath: string;
  try {
    targetPath = resolveSafePath(root, filePath);
  } catch (error: any) {
    return fail({ dryRun, filePath, code: 'UNSAFE_PATH', message: error?.message || 'Unsafe path.' });
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(targetPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return fail({ dryRun, filePath, code: 'FILE_NOT_FOUND', message: `File not found: ${filePath}` });
    }
    return fail({ dryRun, filePath, code: 'INVALID_ARGS', message: error?.message || 'Unable to stat target file.' });
  }

  if (!stat.isFile()) {
    return fail({ dryRun, filePath, code: 'INVALID_ARGS', message: 'Target path must be a file.' });
  }
  if (stat.size > Number(args.maxFileBytes || DEFAULT_MAX_FILE_BYTES)) {
    return fail({ dryRun, filePath, code: 'FILE_TOO_LARGE', message: `Target file is ${stat.size} bytes; limit is ${Number(args.maxFileBytes || DEFAULT_MAX_FILE_BYTES)}.` });
  }

  const before = fs.readFileSync(targetPath, 'utf8');
  const revisionBefore = getFileRevision(targetPath);
  const newlineStyle = detectNewlineStyle(before);
  const normalizedBefore = normalizeNewlines(before);
  const diagnostics: SafeEditResult['diagnostics'] = {
    newlineStyle,
    matchedWithNormalizedNewlines: false,
    hints: [],
  };

  if (args.expectedContentHash || args.expectedSha256) {
    const expected = args.expectedContentHash || args.expectedSha256;
    const actual = crypto.createHash('sha256').update(before, 'utf8').digest('hex');
    if (expected !== actual) {
      return fail({ dryRun, filePath, code: 'CONTENT_CHANGED', message: `File content hash ${actual} does not match expected hash ${expected}.`, diagnostics });
    }
  }

  if (args.expectedRevision || args.fileRevision || args.expectedFileRevision) {
    try {
      assertFileRevisionMatches(targetPath, args, filePath);
    } catch (error: any) {
      return fail({ dryRun, filePath, code: 'CONTENT_CHANGED', message: error?.message || 'File changed since it was read.', diagnostics });
    }
  }

  let after = normalizedBefore;
  for (let i = 0; i < operations.length; i += 1) {
    const rawOperation = operations[i] as SafeEditOperation;
    const normalizedOperation = normalizeOperation(rawOperation);
    if (operationUsedNewlineNormalization(rawOperation) || before !== normalizedBefore) {
      diagnostics.matchedWithNormalizedNewlines = true;
    }
    const result = applyOperation(after, normalizedOperation, i);
    if (result.ok === false) {
      if (before !== normalizedBefore || operationUsedNewlineNormalization(rawOperation)) {
        diagnostics.hints.push('Operation matched against a newline-normalized view; verify anchor text, indentation, and CRLF/LF differences.');
      }
      return {
        ok: false,
        dryRun,
        filePath,
        changed: false,
        changedLines: 0,
        operations: i,
        bytesBefore: byteLength(before),
        bytesAfter: byteLength(restoreNewlines(after, newlineStyle)),
        revisionBefore,
        diagnostics,
        error: { code: result.code, message: result.message, operationIndex: i },
      };
    }
    after = result.value;
  }

  const restoredAfter = restoreNewlines(after, newlineStyle);
  const changed = before !== restoredAfter;
  if (diagnostics.matchedWithNormalizedNewlines) {
    diagnostics.hints.push(`Anchors/content were matched using normalized newlines and output was restored as ${preferredNewline(newlineStyle) === '\r\n' ? 'CRLF' : 'LF'}.`);
  }

  if (changed && !dryRun) {
    try {
      const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${Date.now()}.tmp`);
      fs.writeFileSync(tempPath, restoredAfter, 'utf8');
      fs.renameSync(tempPath, targetPath);
    } catch (e: any) {
      return fail({ dryRun, filePath, code: 'WRITE_FAILED', message: `Failed to write file: ${e.message}`, diagnostics });
    }
  }

  const revisionAfter = !dryRun ? getFileRevision(targetPath) : undefined;

  return {
    ok: true,
    dryRun,
    filePath,
    changed,
    changedLines: countChangedLines(before, restoredAfter),
    operations: operations.length,
    bytesBefore: byteLength(before),
    bytesAfter: byteLength(restoredAfter),
    revisionBefore,
    revisionAfter,
    diagnostics,
    preview: dryRun ? { beforeExcerpt: excerpt(before), afterExcerpt: excerpt(restoredAfter) } : undefined,
  };
}
