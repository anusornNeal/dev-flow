import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDevFlowBackupsDir, getDevFlowDbPath } from '../../lib/devFlowPaths.js';
import { openIsolatedDatabase } from '../../db/index.js';
import { DEVFLOW_MIGRATIONS } from '../../db/migrations/index.js';
import { inspectMigrationCompatibility, runMigrations } from '../../db/migrations/runner.js';

const REQUIRED_CORE_TABLES = ['projects', 'tasks', 'settings', 'skills', 'counters'] as const;
const STATUS_FILENAME = 'recovery-status.json';
const DEFAULT_RETENTION = 7;
const MIN_RETENTION = 2;
const MAX_RETENTION = 50;

export type BackupFailureCode =
  | 'BACKUP_NOT_FOUND'
  | 'BACKUP_CHECKSUM_MISMATCH'
  | 'BACKUP_SQLITE_CORRUPT'
  | 'BACKUP_SCHEMA_INCOMPATIBLE'
  | 'BACKUP_REQUIRED_TABLES_MISSING'
  | 'RESTORE_DRILL_ACTIVE_DB_DENIED'
  | 'RESTORE_DRILL_FAILED';

export interface BackupVerificationResult {
  ok: boolean;
  code?: BackupFailureCode;
  reason?: string;
  integrity?: string;
  schemaVersion?: string | null;
  migrationIds?: string[];
  pendingMigrationIds?: string[];
  counts?: Record<string, number>;
  missingTables?: string[];
  checksumSha256?: string;
}

export interface BackupSnapshotMetadata {
  id: string;
  dbPath: string;
  metadataPath: string;
  createdAt: string;
  checksumSha256: string;
  schemaVersion: string | null;
  migrationIds: string[];
  source: {
    dbPath: string;
    fileSizeBytes: number;
    modifiedAt: string | null;
  };
  validation: {
    ok: boolean;
    integrity: string;
    checkedAt: string;
  };
  counts: Record<string, number>;
  usable: boolean;
}

export interface RestoreDrillResult {
  ok: boolean;
  code?: BackupFailureCode;
  reason?: string;
  backupPath: string;
  checkedAt: string;
  migrated: boolean;
  schemaVersion?: string | null;
  counts: Record<string, number>;
}

export interface RecoveryStatus {
  lastSnapshot?: {
    id: string;
    createdAt: string;
    ok: boolean;
    code?: BackupFailureCode;
  };
  lastVerifiedGoodBackup?: {
    id: string;
    createdAt: string;
    checksumSha256: string;
    schemaVersion: string | null;
  };
  lastRestoreDrill?: {
    checkedAt: string;
    ok: boolean;
    code?: BackupFailureCode;
    reason?: string;
    backupPath: string;
    migrated: boolean;
  };
  failureReason?: {
    code: BackupFailureCode;
    reason: string;
    recordedAt: string;
  } | null;
}

function ensureDirectory(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function checksumFile(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function normalizeRetention(value: unknown) {
  const parsed = Number(value ?? process.env.DEVFLOW_BACKUP_RETENTION ?? DEFAULT_RETENTION);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION;
  return Math.min(MAX_RETENTION, Math.max(MIN_RETENTION, Math.floor(parsed)));
}

function statusPath(backupsDir: string) {
  return path.join(backupsDir, STATUS_FILENAME);
}

function readJson<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

function writeJsonAtomic(filePath: string, value: unknown) {
  ensureDirectory(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

function updateRecoveryStatus(backupsDir: string, patch: Partial<RecoveryStatus>) {
  const current = getRecoveryStatus({ backupsDir });
  const next = { ...current, ...patch };
  writeJsonAtomic(statusPath(backupsDir), next);
  return next;
}

function listTables(connection: any) {
  const rows = connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function collectCounts(connection: any, tables: Set<string>) {
  const counts: Record<string, number> = {};
  for (const table of [...REQUIRED_CORE_TABLES, 'agent_runs', 'attachments']) {
    if (!tables.has(table)) {
      counts[table] = 0;
      continue;
    }
    counts[table] = Number((connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count || 0);
  }
  return counts;
}

function inspectOpenDatabase(connection: any): BackupVerificationResult {
  const integrityRows = connection.pragma('integrity_check') as Array<{ integrity_check?: string }>;
  const integrity = String(integrityRows?.[0]?.integrity_check || '').toLowerCase();
  if (integrity !== 'ok') {
    return { ok: false, code: 'BACKUP_SQLITE_CORRUPT', reason: `SQLite integrity_check returned '${integrity || 'unknown'}'.`, integrity };
  }

  const compatibility = inspectMigrationCompatibility(connection, [...DEVFLOW_MIGRATIONS]);
  if (!compatibility.compatible) {
    return {
      ok: false,
      code: 'BACKUP_SCHEMA_INCOMPATIBLE',
      reason: `Backup contains unsupported migration ids: ${compatibility.unknownIds.join(', ')}.`,
      integrity: 'ok',
      schemaVersion: compatibility.currentVersion,
      migrationIds: compatibility.appliedIds,
      pendingMigrationIds: compatibility.pendingIds,
    };
  }

  const tables = listTables(connection);
  const missingTables = REQUIRED_CORE_TABLES.filter((table) => !tables.has(table));
  if (missingTables.length > 0) {
    return {
      ok: false,
      code: 'BACKUP_REQUIRED_TABLES_MISSING',
      reason: `Backup is missing required tables: ${missingTables.join(', ')}.`,
      integrity: 'ok',
      schemaVersion: compatibility.currentVersion,
      migrationIds: compatibility.appliedIds,
      pendingMigrationIds: compatibility.pendingIds,
      missingTables,
    };
  }

  return {
    ok: true,
    integrity: 'ok',
    schemaVersion: compatibility.currentVersion,
    migrationIds: compatibility.appliedIds,
    pendingMigrationIds: compatibility.pendingIds,
    counts: collectCounts(connection, tables),
  };
}

function failure(code: BackupFailureCode, reason: string, extra: Partial<BackupVerificationResult> = {}): BackupVerificationResult {
  return { ok: false, code, reason, ...extra };
}

export function verifyBackupFile(options: { backupPath: string; expectedChecksum?: string }): BackupVerificationResult {
  const backupPath = path.resolve(options.backupPath);
  if (!fs.existsSync(backupPath)) return failure('BACKUP_NOT_FOUND', `Backup file does not exist: ${backupPath}`);

  const checksumSha256 = checksumFile(backupPath);
  if (options.expectedChecksum && checksumSha256 !== options.expectedChecksum) {
    return failure('BACKUP_CHECKSUM_MISMATCH', 'Backup checksum does not match its recorded snapshot checksum.', { checksumSha256 });
  }

  let connection: any;
  try {
    connection = openIsolatedDatabase(backupPath, { readonly: true });
    return { ...inspectOpenDatabase(connection), checksumSha256 };
  } catch (error: any) {
    return failure('BACKUP_SQLITE_CORRUPT', error instanceof Error ? error.message : 'Backup could not be opened as SQLite.', { checksumSha256 });
  } finally {
    try { connection?.close(); } catch {}
  }
}

function snapshotManifestFiles(backupsDir: string) {
  if (!fs.existsSync(backupsDir)) return [] as Array<{ filePath: string; metadata: BackupSnapshotMetadata }>;
  return fs.readdirSync(backupsDir)
    .filter((name) => /^snapshot-.*\.json$/.test(name))
    .map((name) => {
      const filePath = path.join(backupsDir, name);
      return { filePath, metadata: readJson<BackupSnapshotMetadata>(filePath) };
    })
    .filter((entry): entry is { filePath: string; metadata: BackupSnapshotMetadata } => Boolean(entry.metadata?.id));
}

function pruneSnapshots(backupsDir: string, retention: number) {
  const entries = snapshotManifestFiles(backupsDir)
    .sort((left, right) => Date.parse(right.metadata.createdAt) - Date.parse(left.metadata.createdAt));
  const keep = new Set(entries.slice(0, retention).map((entry) => entry.metadata.id));
  const newestGood = entries.find((entry) => entry.metadata.usable && entry.metadata.validation?.ok);
  if (newestGood) keep.add(newestGood.metadata.id);

  for (const entry of entries) {
    if (keep.has(entry.metadata.id)) continue;
    for (const filePath of [entry.filePath, entry.metadata.dbPath]) {
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch {}
    }
  }
}

function safeTimestamp(now: Date) {
  return now.toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
}

export async function createVerifiedBackupSnapshot(options: {
  sourceDb: any;
  sourceDbPath?: string;
  backupsDir?: string;
  retention?: number;
  now?: Date;
}): Promise<BackupSnapshotMetadata> {
  const backupsDir = path.resolve(options.backupsDir || getDevFlowBackupsDir());
  const sourceDbPath = path.resolve(options.sourceDbPath || getDevFlowDbPath());
  const now = options.now || new Date();
  const id = `${safeTimestamp(now)}-${crypto.randomBytes(3).toString('hex')}`;
  const dbPath = path.join(backupsDir, `snapshot-${id}.db`);
  const metadataPath = path.join(backupsDir, `snapshot-${id}.json`);
  ensureDirectory(backupsDir);

  await options.sourceDb.backup(dbPath);

  // Recovery snapshots are portable by design; persisted integration secrets must never ride along.
  const sanitizedDb = openIsolatedDatabase(dbPath);
  try {
    const tables = listTables(sanitizedDb);
    if (tables.has('settings')) {
      sanitizedDb.prepare("UPDATE settings SET value = '' WHERE key IN ('githubToken', 'jiraToken', 'figmaToken')").run();
      sanitizedDb.pragma('wal_checkpoint(TRUNCATE)');
    }
  } finally {
    sanitizedDb.close();
  }

  const checksumSha256 = checksumFile(dbPath);
  const verification = verifyBackupFile({ backupPath: dbPath, expectedChecksum: checksumSha256 });
  const sourceStat = fs.existsSync(sourceDbPath) ? fs.statSync(sourceDbPath) : null;
  const metadata: BackupSnapshotMetadata = {
    id,
    dbPath,
    metadataPath,
    createdAt: now.toISOString(),
    checksumSha256,
    schemaVersion: verification.schemaVersion || null,
    migrationIds: verification.migrationIds || [],
    source: {
      dbPath: sourceDbPath,
      fileSizeBytes: sourceStat?.size || 0,
      modifiedAt: sourceStat?.mtime?.toISOString?.() || null,
    },
    validation: {
      ok: verification.ok,
      integrity: verification.integrity || 'failed',
      checkedAt: new Date().toISOString(),
    },
    counts: verification.counts || {},
    usable: verification.ok,
  };
  writeJsonAtomic(metadataPath, metadata);

  const statusPatch: Partial<RecoveryStatus> = {
    lastSnapshot: { id, createdAt: metadata.createdAt, ok: verification.ok, code: verification.code },
    failureReason: verification.ok ? null : {
      code: verification.code || 'BACKUP_SQLITE_CORRUPT',
      reason: verification.reason || 'Backup verification failed.',
      recordedAt: new Date().toISOString(),
    },
  };
  if (verification.ok) {
    statusPatch.lastVerifiedGoodBackup = {
      id,
      createdAt: metadata.createdAt,
      checksumSha256,
      schemaVersion: metadata.schemaVersion,
    };
  }
  updateRecoveryStatus(backupsDir, statusPatch);
  pruneSnapshots(backupsDir, normalizeRetention(options.retention));
  return metadata;
}

function recordDrill(backupsDir: string, result: RestoreDrillResult) {
  updateRecoveryStatus(backupsDir, {
    lastRestoreDrill: {
      checkedAt: result.checkedAt,
      ok: result.ok,
      code: result.code,
      reason: result.reason,
      backupPath: result.backupPath,
      migrated: result.migrated,
    },
    failureReason: result.ok ? null : {
      code: result.code || 'RESTORE_DRILL_FAILED',
      reason: result.reason || 'Restore drill failed.',
      recordedAt: result.checkedAt,
    },
  });
  return result;
}

export async function runRestoreDrill(options: {
  backupPath: string;
  expectedChecksum?: string;
  activeDbPath?: string;
  tempRoot?: string;
  backupsDir?: string;
}): Promise<RestoreDrillResult> {
  const backupPath = path.resolve(options.backupPath);
  const activeDbPath = path.resolve(options.activeDbPath || getDevFlowDbPath());
  const backupsDir = path.resolve(options.backupsDir || getDevFlowBackupsDir());
  const checkedAt = new Date().toISOString();

  if (backupPath === activeDbPath) {
    return recordDrill(backupsDir, {
      ok: false,
      code: 'RESTORE_DRILL_ACTIVE_DB_DENIED',
      reason: 'Restore drill refuses to use the active database path directly.',
      backupPath,
      checkedAt,
      migrated: false,
      counts: {},
    });
  }

  const preflight = verifyBackupFile({ backupPath, expectedChecksum: options.expectedChecksum });
  if (!preflight.ok) {
    return recordDrill(backupsDir, {
      ok: false,
      code: preflight.code,
      reason: preflight.reason,
      backupPath,
      checkedAt,
      migrated: false,
      counts: {},
    });
  }

  const tempRoot = path.resolve(options.tempRoot || path.join(os.tmpdir(), 'devflow-restore-drills'));
  ensureDirectory(tempRoot);
  const drillDir = fs.mkdtempSync(path.join(tempRoot, 'drill-'));
  const drillDbPath = path.join(drillDir, 'devflow-drill.db');
  fs.copyFileSync(backupPath, drillDbPath);

  let connection: any;
  try {
    connection = openIsolatedDatabase(drillDbPath);
    const before = inspectMigrationCompatibility(connection, [...DEVFLOW_MIGRATIONS]);
    if (!before.compatible) {
      return recordDrill(backupsDir, {
        ok: false,
        code: 'BACKUP_SCHEMA_INCOMPATIBLE',
        reason: `Backup contains unsupported migration ids: ${before.unknownIds.join(', ')}.`,
        backupPath,
        checkedAt,
        migrated: false,
        counts: {},
      });
    }

    const migrated = before.pendingIds.length > 0;
    if (migrated) runMigrations(connection, [...DEVFLOW_MIGRATIONS]);
    const after = inspectOpenDatabase(connection);
    if (!after.ok) {
      return recordDrill(backupsDir, {
        ok: false,
        code: after.code || 'RESTORE_DRILL_FAILED',
        reason: after.reason,
        backupPath,
        checkedAt,
        migrated,
        counts: {},
      });
    }

    return recordDrill(backupsDir, {
      ok: true,
      backupPath,
      checkedAt,
      migrated,
      schemaVersion: DEVFLOW_MIGRATIONS.at(-1)?.id || null,
      counts: after.counts || {},
    });
  } catch (error: any) {
    return recordDrill(backupsDir, {
      ok: false,
      code: 'RESTORE_DRILL_FAILED',
      reason: error instanceof Error ? error.message : 'Restore drill failed.',
      backupPath,
      checkedAt,
      migrated: false,
      counts: {},
    });
  } finally {
    try { connection?.close(); } catch {}
    try { fs.rmSync(drillDir, { recursive: true, force: true }); } catch {}
  }
}

export function getRecoveryStatus(options: { backupsDir?: string } = {}): RecoveryStatus {
  const backupsDir = path.resolve(options.backupsDir || getDevFlowBackupsDir());
  return readJson<RecoveryStatus>(statusPath(backupsDir)) || {};
}

export function getLatestVerifiedSnapshot(options: { backupsDir?: string } = {}) {
  const backupsDir = path.resolve(options.backupsDir || getDevFlowBackupsDir());
  return snapshotManifestFiles(backupsDir)
    .filter((entry) => entry.metadata.usable && entry.metadata.validation?.ok && fs.existsSync(entry.metadata.dbPath))
    .sort((left, right) => Date.parse(right.metadata.createdAt) - Date.parse(left.metadata.createdAt))[0]?.metadata || null;
}

export async function runLatestRestoreDrill(options: { backupsDir?: string; activeDbPath?: string; tempRoot?: string } = {}) {
  const snapshot = getLatestVerifiedSnapshot({ backupsDir: options.backupsDir });
  if (!snapshot) {
    const backupsDir = path.resolve(options.backupsDir || getDevFlowBackupsDir());
    return recordDrill(backupsDir, {
      ok: false,
      code: 'BACKUP_NOT_FOUND',
      reason: 'No verified recovery snapshot is available for a restore drill.',
      backupPath: '',
      checkedAt: new Date().toISOString(),
      migrated: false,
      counts: {},
    });
  }
  return runRestoreDrill({
    backupPath: snapshot.dbPath,
    expectedChecksum: snapshot.checksumSha256,
    activeDbPath: options.activeDbPath,
    tempRoot: options.tempRoot,
    backupsDir: options.backupsDir,
  });
}
