import { spawnSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { createApiError } from './api';
import { resolveProjectRoot, resolveSafePath } from './localFileService';

const DEFAULT_MAX_PATCH_BYTES = 100_000;
const DEFAULT_MAX_SUMMARY_BYTES = 5_000;

export interface LocalPatchChangedFile {
  path: string;
  exists: boolean;
  sizeBytes: number | null;
}

export interface LocalPatchResult {
  changedFiles: string[];
  changedFileCount: number;
  changedFileMetadata: LocalPatchChangedFile[];
  dryRun: boolean;
  applied: boolean;
  exitCode: number | null;
  summary: string;
  diagnostics: {
    output: string;
    truncated: boolean;
    maxBytes: number;
  };
  truncated: boolean;
}

function normalizePatchFlag(value: unknown) {
  return value === true || String(value).toLowerCase() === 'true' || String(value).toLowerCase() === 'check';
}

function truncateOutput(value: string, maxBytes: number) {
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes <= maxBytes) {
    return { value, truncated: false };
  }
  return {
    value: `${Buffer.from(value, 'utf8').subarray(0, maxBytes).toString('utf8')}\n[truncated]`,
    truncated: true,
  };
}

function stripDiffPathPrefix(rawPath: string) {
  const cleaned = rawPath.trim().split(/\t/)[0].trim();
  if (!cleaned || cleaned === '/dev/null') return '';
  if (cleaned.startsWith('"') && cleaned.endsWith('"')) {
    return cleaned.slice(1, -1);
  }
  return cleaned.replace(/^[ab]\//, '');
}

function isUnsafePatchPath(relativePath: string) {
  return (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    /^[A-Za-z]:[\\/]/.test(relativePath) ||
    relativePath.split(/[\\/]+/).includes('..')
  );
}

function assertRealPathInsideRoot(root: string, targetPath: string, relativePath: string) {
  const realRoot = fs.realpathSync(root);
  let existingPath = targetPath;
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) break;
    existingPath = parent;
  }

  const realExistingPath = fs.realpathSync(existingPath);
  const relativeRealPath = path.relative(realRoot, realExistingPath);
  if (relativeRealPath.startsWith('..') || path.isAbsolute(relativeRealPath)) {
    throw createApiError(403, 'PATCH_PATH_DENIED', 'Patch paths must stay inside the selected project root.', {
      affectedId: relativePath,
    });
  }
}

function resolvePatchLimits(args: Record<string, any>) {
  const maxPatchBytes = Number.isFinite(Number(args.maxPatchBytes))
    ? Math.max(1, Math.min(1_000_000, Number(args.maxPatchBytes)))
    : DEFAULT_MAX_PATCH_BYTES;
  const maxSummaryBytes = Number.isFinite(Number(args.maxSummaryBytes))
    ? Math.max(1, Math.min(100_000, Number(args.maxSummaryBytes)))
    : DEFAULT_MAX_SUMMARY_BYTES;
  return { maxPatchBytes, maxSummaryBytes };
}

function assertPatchSize(patch: string, maxPatchBytes: number) {
  if (Buffer.byteLength(patch, 'utf8') > maxPatchBytes) {
    throw createApiError(400, 'PATCH_TOO_LARGE', `patch must be ${maxPatchBytes} bytes or smaller.`);
  }
}

export function validatePatchPaths(root: string, patch: string) {
  if (/^GIT binary patch$/m.test(patch) || /^Binary files .+ differ$/m.test(patch)) {
    throw createApiError(400, 'BINARY_PATCH_UNSUPPORTED', 'Binary patches are not supported.');
  }

  const changedFiles = new Set<string>();
  const pathCandidates: string[] = [];

  for (const line of patch.split(/\r?\n/)) {
    const diffGitMatch = /^diff --git\s+(.+?)\s+(.+)$/.exec(line);
    if (diffGitMatch) {
      pathCandidates.push(diffGitMatch[1], diffGitMatch[2]);
      continue;
    }

    const fileHeaderMatch = /^(?:---|\+\+\+)\s+(.+)$/.exec(line);
    if (fileHeaderMatch) {
      pathCandidates.push(fileHeaderMatch[1]);
    }
  }

  for (const candidate of pathCandidates) {
    const relativePath = stripDiffPathPrefix(candidate).replace(/\\/g, '/');
    if (!relativePath) continue;
    if (isUnsafePatchPath(relativePath)) {
      throw createApiError(403, 'PATCH_PATH_DENIED', 'Patch paths must stay inside the selected project root.', {
        affectedId: relativePath,
      });
    }
    const targetPath = resolveSafePath(root, relativePath);
    assertRealPathInsideRoot(root, targetPath, relativePath);
    changedFiles.add(relativePath);
  }

  if (changedFiles.size === 0 || !/^@@\s/m.test(patch)) {
    throw createApiError(400, 'INVALID_PATCH', 'patch must be a unified diff with at least one file hunk.');
  }

  return Array.from(changedFiles).sort();
}

function buildChangedFileMetadata(root: string, changedFiles: string[]): LocalPatchChangedFile[] {
  return changedFiles.map((relativePath) => {
    const targetPath = resolveSafePath(root, relativePath);
    if (!fs.existsSync(targetPath)) {
      return { path: relativePath, exists: false, sizeBytes: null };
    }
    const stat = fs.statSync(targetPath);
    return { path: relativePath, exists: true, sizeBytes: stat.isFile() ? stat.size : null };
  });
}

function buildPatchResult(params: {
  root: string;
  changedFiles: string[];
  dryRun: boolean;
  applied: boolean;
  exitCode: number | null;
  output: string;
  maxSummaryBytes: number;
}): LocalPatchResult {
  const summarySource = [
    `${params.dryRun ? 'Checked' : 'Applied'} patch for ${params.changedFiles.length} file(s): ${params.changedFiles.join(', ')}`,
    params.output,
  ].filter(Boolean).join('\n');
  const summary = truncateOutput(summarySource, params.maxSummaryBytes);
  return {
    changedFiles: params.changedFiles,
    changedFileCount: params.changedFiles.length,
    changedFileMetadata: buildChangedFileMetadata(params.root, params.changedFiles),
    dryRun: params.dryRun,
    applied: params.applied,
    exitCode: params.exitCode,
    summary: summary.value,
    diagnostics: {
      output: summary.value,
      truncated: summary.truncated,
      maxBytes: params.maxSummaryBytes,
    },
    truncated: summary.truncated,
  };
}

export function applyLocalPatch(state: AppState, args: Record<string, any>): LocalPatchResult {
  const root = resolveProjectRoot(state, args);
  const patch = typeof args.patch === 'string' ? args.patch : '';
  if (!patch.trim()) {
    throw createApiError(400, 'PATCH_REQUIRED', 'patch is required.');
  }

  const { maxPatchBytes, maxSummaryBytes } = resolvePatchLimits(args);
  assertPatchSize(patch, maxPatchBytes);

  const changedFiles = validatePatchPaths(root, patch);
  const dryRun = normalizePatchFlag(args.dryRun ?? args.check);
  const gitArgs = ['apply', dryRun ? '--check' : '--whitespace=nowarn'];
  const result = spawnSync('git', gitArgs, {
    cwd: root,
    input: patch,
    encoding: 'utf8',
    shell: false,
    maxBuffer: 1_000_000,
  });

  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  const patchResult = buildPatchResult({
    root,
    changedFiles,
    dryRun,
    applied: !dryRun,
    exitCode: result.status,
    output,
    maxSummaryBytes,
  });

  if (result.error || result.status !== 0) {
    throw createApiError(400, 'PATCH_APPLY_FAILED', dryRun ? 'Patch check failed.' : 'Patch apply failed.', {
      details: {
        changedFiles,
        changedFileCount: changedFiles.length,
        changedFileMetadata: patchResult.changedFileMetadata,
        dryRun,
        applied: false,
        exitCode: result.status,
        output: patchResult.summary,
        truncated: patchResult.truncated,
        retryable: true,
      },
    });
  }

  return patchResult;
}

export async function applyLocalPatchAsync(state: AppState, args: Record<string, any>, logger: { stdout: (data: string) => void, stderr: (data: string) => void }, setCancelFn: (fn: () => void) => void): Promise<LocalPatchResult> {
  const root = resolveProjectRoot(state, args);
  const patch = typeof args.patch === 'string' ? args.patch : '';
  const dryRun = normalizePatchFlag(args.dryRun ?? args.check);

  if (!patch.trim()) throw createApiError(400, 'MISSING_PATCH_CONTENT', 'Patch content is required.');

  const { maxPatchBytes, maxSummaryBytes } = resolvePatchLimits(args);
  assertPatchSize(patch, maxPatchBytes);
  const changedFiles = validatePatchPaths(root, patch);
  const gitArgs = ['apply', dryRun ? '--check' : '--whitespace=nowarn'];
  
  return new Promise((resolve, reject) => {
    const child = spawn('git', gitArgs, {
      cwd: root,
      shell: false,
    });
    
    let stdoutBuffer = '';
    let stderrBuffer = '';

    setCancelFn(() => {
      child.kill('SIGTERM');
      reject(new Error('Job cancelled'));
    });

    child.stdout.on('data', (data) => {
      const chunk = data.toString('utf8');
      stdoutBuffer += chunk;
      logger.stdout(chunk);
    });

    child.stderr.on('data', (data) => {
      const chunk = data.toString('utf8');
      stderrBuffer += chunk;
      logger.stderr(chunk);
    });

    child.on('error', (err) => {
      reject(createApiError(500, 'PATCH_EXEC_ERROR', 'Failed to execute git apply.', { details: err.message }));
    });

    child.on('close', (code) => {
      const output = [stdoutBuffer, stderrBuffer].filter(Boolean).join('\n').trim();
      const patchResult = buildPatchResult({
        root,
        changedFiles,
        dryRun,
        applied: !dryRun,
        exitCode: code,
        output,
        maxSummaryBytes,
      });

      if (code !== 0) {
        reject(createApiError(400, 'PATCH_APPLY_FAILED', dryRun ? 'Patch check failed.' : 'Patch apply failed.', {
          details: {
            changedFiles,
            changedFileCount: changedFiles.length,
            changedFileMetadata: patchResult.changedFileMetadata,
            dryRun,
            applied: false,
            exitCode: code,
            output: patchResult.summary,
            truncated: patchResult.truncated,
            retryable: true,
          }
        }));
        return;
      }

      resolve(patchResult);
    });

    // Write patch to stdin
    child.stdin.write(patch, 'utf8', () => {
      child.stdin.end();
    });
  });
}
