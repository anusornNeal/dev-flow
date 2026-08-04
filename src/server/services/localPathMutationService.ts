import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppState } from '../types';
import { createApiError } from './api';
import {
  assertFileRevisionMatches,
  getFileRevision,
  resolveProjectRoot,
  resolveSafePath,
} from './localFileService';
import { invalidateRepoReadCaches } from './repoCacheInvalidationService';

const MAX_OPERATIONS = 100;
const PROTECTED_SEGMENTS = new Set(['.git', '.devflow']);

type DeleteOperation = {
  type: 'delete';
  path: string;
  expectedRevision?: string;
  expectedContentHash?: string;
  expectedSha256?: string;
};

type MoveOperation = {
  type: 'move';
  from: string;
  to: string;
  expectedRevision?: string;
  expectedContentHash?: string;
  expectedSha256?: string;
};

export type PathMutationOperation = DeleteOperation | MoveOperation;

type PlannedOperation = PathMutationOperation & {
  sourcePath: string;
  destinationPath?: string;
  sourceType: 'file' | 'directory';
  sizeBytes: number | null;
  revision?: ReturnType<typeof getFileRevision>;
};

export interface PathMutationResult {
  ok: boolean;
  dryRun: boolean;
  applied: boolean;
  operationCount: number;
  operations: Array<{
    type: 'delete' | 'move';
    path?: string;
    from?: string;
    to?: string;
    sourceType: 'file' | 'directory';
    sizeBytes: number | null;
    revision?: ReturnType<typeof getFileRevision>;
  }>;
  affectedPaths: string[];
  gitPreview: Array<{ status: 'deleted' | 'renamed'; path?: string; from?: string; to?: string }>;
  rolledBack: boolean;
  cacheInvalidation?: ReturnType<typeof invalidateRepoReadCaches>;
  backupCleanupWarning?: string;
}

export interface PathMutationIo {
  existsSync(targetPath: fs.PathLike): boolean;
  lstatSync(targetPath: fs.PathLike): fs.Stats;
  statSync(targetPath: fs.PathLike): fs.Stats;
  realpathSync(targetPath: fs.PathLike): string;
  renameSync(oldPath: fs.PathLike, newPath: fs.PathLike): void;
  mkdirSync(targetPath: fs.PathLike, options?: fs.MakeDirectoryOptions & { recursive?: boolean }): string | undefined;
  rmSync(targetPath: fs.PathLike, options?: fs.RmOptions): void;
}

const defaultIo: PathMutationIo = {
  existsSync: fs.existsSync,
  lstatSync: fs.lstatSync,
  statSync: fs.statSync,
  realpathSync: fs.realpathSync,
  renameSync: fs.renameSync,
  mkdirSync: fs.mkdirSync,
  rmSync: fs.rmSync,
};

function bool(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'check';
}

function normalizeRelativePath(value: unknown, field: string) {
  const normalized = typeof value === 'string' ? value.trim().replace(/\\/g, '/') : '';
  if (!normalized || normalized === '.') {
    throw createApiError(400, 'PATH_REQUIRED', `${field} must identify a path inside the project root.`);
  }
  const segments = normalized.split('/').filter(Boolean);
  if (segments.some((segment) => PROTECTED_SEGMENTS.has(segment))) {
    throw createApiError(403, 'PROTECTED_PATH', `Path '${normalized}' is protected and cannot be mutated.`, { affectedId: normalized });
  }
  return normalized;
}

function toRelativePath(root: string, targetPath: string) {
  return path.relative(root, targetPath).replace(/\\/g, '/') || '.';
}

function assertRealPathInsideRoot(root: string, targetPath: string, displayPath: string, io: PathMutationIo) {
  const realRoot = io.realpathSync(root);
  let existing = targetPath;
  while (!io.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  const realExisting = io.realpathSync(existing);
  const relative = path.relative(realRoot, realExisting);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw createApiError(403, 'PATH_ESCAPE_DENIED', `Path '${displayPath}' resolves outside the project root.`, { affectedId: displayPath });
  }
}

function assertSource(root: string, relativePath: string, operation: PathMutationOperation, io: PathMutationIo): PlannedOperation {
  const sourcePath = resolveSafePath(root, relativePath);
  if (!io.existsSync(sourcePath)) {
    throw createApiError(404, 'PATH_NOT_FOUND', `Path '${relativePath}' was not found.`, { affectedId: relativePath });
  }
  assertRealPathInsideRoot(root, sourcePath, relativePath, io);
  const lstat = io.lstatSync(sourcePath);
  if (lstat.isSymbolicLink()) {
    throw createApiError(403, 'SYMLINK_MUTATION_DENIED', `Symbolic link '${relativePath}' cannot be mutated by this tool.`, { affectedId: relativePath });
  }
  const sourceType = lstat.isDirectory() ? 'directory' : lstat.isFile() ? 'file' : null;
  if (!sourceType) {
    throw createApiError(400, 'UNSUPPORTED_PATH_TYPE', `Path '${relativePath}' is not a regular file or directory.`, { affectedId: relativePath });
  }

  const revisionArgs = {
    expectedRevision: operation.expectedRevision,
    expectedContentHash: operation.expectedContentHash,
    expectedSha256: operation.expectedSha256,
  };
  const hasRevision = Object.values(revisionArgs).some((value) => typeof value === 'string' && value.trim());
  if (hasRevision && sourceType !== 'file') {
    throw createApiError(400, 'DIRECTORY_REVISION_UNSUPPORTED', `Revision guards are supported only for files; '${relativePath}' is a directory.`, { affectedId: relativePath });
  }
  if (sourceType === 'file') {
    assertFileRevisionMatches(sourcePath, revisionArgs, relativePath);
  }

  const stat = io.statSync(sourcePath);
  return {
    ...operation,
    sourcePath,
    sourceType,
    sizeBytes: sourceType === 'file' ? stat.size : null,
    revision: sourceType === 'file' ? getFileRevision(sourcePath) : undefined,
  };
}

function normalizeOperations(args: Record<string, any>): PathMutationOperation[] {
  if (Array.isArray(args.operations)) {
    return args.operations.map((entry: any) => {
      const type = String(entry?.type || '').toLowerCase();
      if (type === 'delete') {
        return {
          type: 'delete',
          path: normalizeRelativePath(entry.path, 'operations[].path'),
          expectedRevision: entry.expectedRevision,
          expectedContentHash: entry.expectedContentHash,
          expectedSha256: entry.expectedSha256,
        };
      }
      if (type === 'move' || type === 'rename') {
        return {
          type: 'move',
          from: normalizeRelativePath(entry.from, 'operations[].from'),
          to: normalizeRelativePath(entry.to, 'operations[].to'),
          expectedRevision: entry.expectedRevision,
          expectedContentHash: entry.expectedContentHash,
          expectedSha256: entry.expectedSha256,
        };
      }
      throw createApiError(400, 'INVALID_PATH_OPERATION', `Unsupported path operation '${type || String(entry?.type || '')}'. Use 'delete' or 'move'.`);
    });
  }
  throw createApiError(400, 'PATH_OPERATIONS_REQUIRED', 'operations must contain at least one delete or move operation.');
}

function preflightOperations(root: string, operations: PathMutationOperation[], io: PathMutationIo): PlannedOperation[] {
  if (operations.length === 0) {
    throw createApiError(400, 'PATH_OPERATIONS_REQUIRED', 'At least one path operation is required.');
  }
  if (operations.length > MAX_OPERATIONS) {
    throw createApiError(400, 'TOO_MANY_PATH_OPERATIONS', `At most ${MAX_OPERATIONS} path operations are allowed per batch.`);
  }

  const sourceKeys = new Set<string>();
  const destinationKeys = new Set<string>();
  const planned = operations.map((operation) => {
    const relativeSource = operation.type === 'delete' ? operation.path : operation.from;
    const sourceKey = path.resolve(resolveSafePath(root, relativeSource));
    if (sourceKeys.has(sourceKey)) {
      throw createApiError(400, 'DUPLICATE_PATH_OPERATION', `Path '${relativeSource}' appears more than once as a mutation source.`, { affectedId: relativeSource });
    }
    sourceKeys.add(sourceKey);
    const plan = assertSource(root, relativeSource, operation, io);

    if (operation.type === 'move') {
      const destinationPath = resolveSafePath(root, operation.to);
      assertRealPathInsideRoot(root, destinationPath, operation.to, io);
      const destinationKey = path.resolve(destinationPath);
      if (destinationKey === sourceKey) {
        throw createApiError(400, 'MOVE_SOURCE_EQUALS_DESTINATION', `Move source and destination are the same path: '${operation.from}'.`, { affectedId: operation.from });
      }
      if (destinationKeys.has(destinationKey)) {
        throw createApiError(400, 'DUPLICATE_MOVE_DESTINATION', `More than one move targets '${operation.to}'.`, { affectedId: operation.to });
      }
      destinationKeys.add(destinationKey);
      if (io.existsSync(destinationPath)) {
        throw createApiError(409, 'MOVE_DESTINATION_EXISTS', `Move destination '${operation.to}' already exists.`, { affectedId: operation.to });
      }
      const destinationParent = path.dirname(destinationPath);
      if (!io.existsSync(destinationParent) || !io.statSync(destinationParent).isDirectory()) {
        throw createApiError(404, 'MOVE_DESTINATION_PARENT_NOT_FOUND', `Destination parent for '${operation.to}' does not exist.`, { affectedId: operation.to });
      }
      if (plan.sourceType === 'directory') {
        const relativeDestination = path.relative(plan.sourcePath, destinationPath);
        if (relativeDestination === '' || (!relativeDestination.startsWith('..') && !path.isAbsolute(relativeDestination))) {
          throw createApiError(400, 'MOVE_INTO_SELF_DENIED', `Directory '${operation.from}' cannot be moved inside itself.`, { affectedId: operation.to });
        }
      }
      plan.destinationPath = destinationPath;
    }
    return plan;
  });

  for (let left = 0; left < planned.length; left += 1) {
    for (let right = left + 1; right < planned.length; right += 1) {
      const leftSource = planned[left].sourcePath;
      const rightSource = planned[right].sourcePath;
      const leftContainsRight = path.relative(leftSource, rightSource);
      const rightContainsLeft = path.relative(rightSource, leftSource);
      if ((leftContainsRight && !leftContainsRight.startsWith('..') && !path.isAbsolute(leftContainsRight))
        || (rightContainsLeft && !rightContainsLeft.startsWith('..') && !path.isAbsolute(rightContainsLeft))) {
        throw createApiError(400, 'OVERLAPPING_PATH_OPERATIONS', 'A batch cannot mutate both a directory and one of its descendants.', {
          details: [toRelativePath(root, leftSource), toRelativePath(root, rightSource)],
        });
      }
    }
  }

  for (const plan of planned) {
    if (plan.type === 'move' && sourceKeys.has(path.resolve(plan.destinationPath!))) {
      throw createApiError(400, 'MOVE_CHAIN_UNSUPPORTED', `Move destination '${plan.to}' is also a source in the same batch. Split chained moves into separate calls.`);
    }
  }

  return planned;
}

function serializePlan(root: string, planned: PlannedOperation[]) {
  return planned.map((plan) => plan.type === 'delete'
    ? {
        type: 'delete' as const,
        path: plan.path,
        sourceType: plan.sourceType,
        sizeBytes: plan.sizeBytes,
        revision: plan.revision,
      }
    : {
        type: 'move' as const,
        from: plan.from,
        to: plan.to,
        sourceType: plan.sourceType,
        sizeBytes: plan.sizeBytes,
        revision: plan.revision,
      });
}

function buildResult(root: string, planned: PlannedOperation[], dryRun: boolean, rolledBack: boolean): PathMutationResult {
  const operations = serializePlan(root, planned);
  const affectedPaths = Array.from(new Set(planned.flatMap((plan) => plan.type === 'delete' ? [plan.path] : [plan.from, plan.to]))).sort();
  const gitPreview = planned.map((plan) => plan.type === 'delete'
    ? { status: 'deleted' as const, path: plan.path }
    : { status: 'renamed' as const, from: plan.from, to: plan.to });
  return {
    ok: true,
    dryRun,
    applied: !dryRun,
    operationCount: planned.length,
    operations,
    affectedPaths,
    gitPreview,
    rolledBack,
  };
}

export function applyPathMutations(
  state: AppState,
  args: Record<string, any>,
  io: PathMutationIo = defaultIo,
): PathMutationResult {
  const root = resolveProjectRoot(state, args);
  const operations = normalizeOperations(args);
  const planned = preflightOperations(root, operations, io);
  const dryRun = bool(args.dryRun ?? args.check) || String(args.mode || '').toLowerCase() === 'dry-run';
  const result = buildResult(root, planned, dryRun, false);
  if (dryRun) return result;

  const transactionId = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const backupDir = path.join(root, '.devflow', 'path-mutation-backups', transactionId);
  io.mkdirSync(backupDir, { recursive: true });
  const completed: Array<
    | { type: 'delete'; sourcePath: string; backupPath: string }
    | { type: 'move'; sourcePath: string; destinationPath: string }
  > = [];

  try {
    for (let index = 0; index < planned.length; index += 1) {
      const plan = planned[index];
      if (plan.type === 'delete') {
        const backupPath = path.join(backupDir, String(index));
        io.renameSync(plan.sourcePath, backupPath);
        completed.push({ type: 'delete', sourcePath: plan.sourcePath, backupPath });
      } else {
        io.renameSync(plan.sourcePath, plan.destinationPath!);
        completed.push({ type: 'move', sourcePath: plan.sourcePath, destinationPath: plan.destinationPath! });
      }
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const completedOperation of completed.reverse()) {
      try {
        if (completedOperation.type === 'delete') {
          if (io.existsSync(completedOperation.backupPath)) {
            io.renameSync(completedOperation.backupPath, completedOperation.sourcePath);
          }
        } else if (io.existsSync(completedOperation.destinationPath)) {
          io.renameSync(completedOperation.destinationPath, completedOperation.sourcePath);
        }
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
      }
    }
    try {
      io.rmSync(backupDir, { recursive: true, force: true });
    } catch (cleanupError) {
      rollbackErrors.push(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    }
    throw createApiError(500, rollbackErrors.length > 0 ? 'PATH_MUTATION_ROLLBACK_FAILED' : 'PATH_MUTATION_FAILED', 'Path mutation failed; completed operations were rolled back.', {
      details: {
        cause: error instanceof Error ? error.message : String(error),
        rollbackErrors,
        completedOperationCount: completed.length,
      },
      retryable: rollbackErrors.length === 0,
    });
  }

  let backupCleanupWarning: string | undefined;
  try {
    io.rmSync(backupDir, { recursive: true, force: true });
  } catch (error) {
    backupCleanupWarning = error instanceof Error ? error.message : String(error);
  }

  const cacheInvalidation = invalidateRepoReadCaches(root, 'applyPathMutations');
  return {
    ...result,
    cacheInvalidation,
    backupCleanupWarning,
  };
}

export function deleteLocalPath(state: AppState, args: Record<string, any>, io: PathMutationIo = defaultIo) {
  const paths = Array.isArray(args.paths)
    ? args.paths
    : args.path || args.filePath
      ? [args.path || args.filePath]
      : [];
  const expectedRevisions = args.expectedRevisions && typeof args.expectedRevisions === 'object'
    ? args.expectedRevisions as Record<string, string>
    : {};
  return applyPathMutations(state, {
    ...args,
    operations: paths.map((entry: unknown) => {
      const relativePath = normalizeRelativePath(entry, 'paths[]');
      return {
        type: 'delete',
        path: relativePath,
        expectedRevision: expectedRevisions[relativePath] || (paths.length === 1 ? args.expectedRevision : undefined),
        expectedContentHash: paths.length === 1 ? args.expectedContentHash : undefined,
        expectedSha256: paths.length === 1 ? args.expectedSha256 : undefined,
      };
    }),
  }, io);
}

export function moveLocalPath(state: AppState, args: Record<string, any>, io: PathMutationIo = defaultIo) {
  const moves = Array.isArray(args.moves) ? args.moves : [];
  if (moves.length === 0 && (args.from || args.to)) {
    moves.push({ from: args.from, to: args.to });
  }
  return applyPathMutations(state, {
    ...args,
    operations: moves.map((entry: any) => ({
      type: 'move',
      from: normalizeRelativePath(entry?.from, 'moves[].from'),
      to: normalizeRelativePath(entry?.to, 'moves[].to'),
      expectedRevision: entry?.expectedRevision,
      expectedContentHash: entry?.expectedContentHash,
      expectedSha256: entry?.expectedSha256,
    })),
  }, io);
}
