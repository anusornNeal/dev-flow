import fs from 'node:fs';
import path from 'node:path';
import { getDevFlowDataDir, getDevFlowDbPath } from '../../lib/devFlowPaths.js';
import { verifyBackupFile, type BackupVerificationResult } from './backupIntegrityService.js';

const PENDING_IMPORT_PREFIX = 'devflow-import-pending-';
const PENDING_IMPORT_SUFFIX = '.db';

export type StageDatabaseImportOptions = {
  sourcePath: string;
  dataDir?: string;
  now?: Date;
};

export type ApplyPendingDatabaseImportOptions = {
  dataDir?: string;
  targetDbPath?: string;
};

export type AppliedDatabaseImport = {
  pendingPath: string;
  targetDbPath: string;
  verification: BackupVerificationResult;
};

function ensureDirectory(directory: string) {
  fs.mkdirSync(directory, { recursive: true });
}

function importTimestamp(now: Date) {
  return now.toISOString().replace(/[:.]/g, '-');
}

function sqliteSidecarPaths(dbPath: string) {
  return [`${dbPath}-wal`, `${dbPath}-shm`];
}

export function removeSqliteSidecars(dbPath: string) {
  for (const sidecarPath of sqliteSidecarPaths(dbPath)) {
    try {
      fs.unlinkSync(sidecarPath);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function stageDatabaseImport(options: StageDatabaseImportOptions) {
  const dataDir = path.resolve(options.dataDir || getDevFlowDataDir());
  const sourcePath = path.resolve(options.sourcePath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Database import source does not exist: ${sourcePath}`);

  ensureDirectory(dataDir);
  removeSqliteSidecars(sourcePath);
  const pendingPath = path.join(dataDir, `${PENDING_IMPORT_PREFIX}${importTimestamp(options.now || new Date())}.db`);
  fs.renameSync(sourcePath, pendingPath);
  removeSqliteSidecars(pendingPath);
  return pendingPath;
}

function findPendingDatabaseImport(dataDir: string) {
  if (!fs.existsSync(dataDir)) return null;
  const candidates = fs.readdirSync(dataDir)
    .filter((name) => name.startsWith(PENDING_IMPORT_PREFIX) && name.endsWith(PENDING_IMPORT_SUFFIX))
    .sort();
  const latest = candidates.at(-1);
  return latest ? path.join(dataDir, latest) : null;
}

function importVerificationError(verification: BackupVerificationResult, filePath: string) {
  const error = new Error(verification.reason || `Database import verification failed for ${filePath}.`) as Error & { code?: string };
  error.code = verification.code || 'BACKUP_VALIDATION_FAILED';
  return error;
}

export function applyPendingDatabaseImport(options: ApplyPendingDatabaseImportOptions = {}): AppliedDatabaseImport | null {
  const dataDir = path.resolve(options.dataDir || getDevFlowDataDir());
  const targetDbPath = path.resolve(options.targetDbPath || getDevFlowDbPath());
  const pendingPath = findPendingDatabaseImport(dataDir);
  if (!pendingPath) return null;

  const sourceVerification = verifyBackupFile({ backupPath: pendingPath });
  if (!sourceVerification.ok) throw importVerificationError(sourceVerification, pendingPath);

  ensureDirectory(path.dirname(targetDbPath));
  // Startup owns the only database connection at this point. Discard sidecars
  // from the previous database before installing the staged main file.
  removeSqliteSidecars(targetDbPath);
  fs.copyFileSync(pendingPath, targetDbPath);
  removeSqliteSidecars(targetDbPath);

  const installedVerification = verifyBackupFile({ backupPath: targetDbPath });
  if (!installedVerification.ok) throw importVerificationError(installedVerification, targetDbPath);
  removeSqliteSidecars(targetDbPath);
  removeSqliteSidecars(pendingPath);
  fs.unlinkSync(pendingPath);

  return {
    pendingPath,
    targetDbPath,
    verification: installedVerification,
  };
}
