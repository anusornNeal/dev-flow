import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const {
  createVerifiedBackupSnapshot,
  verifyBackupFile,
  runRestoreDrill,
  getRecoveryStatus,
} = await import('../../src/server/services/backupIntegrityService.js');
const { runMigrations } = await import('../../src/db/migrations/runner.js');
const { DEVFLOW_MIGRATIONS } = await import('../../src/db/migrations/index.js');

function sha256(filePath: string) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeDb(root: string, name: string, migrationCount: number = DEVFLOW_MIGRATIONS.length) {
  const dbPath = path.join(root, name);
  const db = new Database(dbPath);
  runMigrations(db, DEVFLOW_MIGRATIONS.slice(0, migrationCount));
  db.prepare("INSERT OR REPLACE INTO projects (id, name, createdAt) VALUES ('p1', 'Backup Fixture', '2026-08-09')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('githubToken', 'must-not-leak')").run();
  return { db, dbPath };
}

test('creates a checksummed verified snapshot with schema metadata and strips portable secrets', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-backup-valid-'));
  const backupsDir = path.join(root, 'backups');
  const { db, dbPath } = makeDb(root, 'active.db');
  try {
    const snapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: dbPath, backupsDir, retention: 3 });
    assert.equal(snapshot.validation.ok, true);
    assert.equal(snapshot.validation.integrity, 'ok');
    assert.equal(snapshot.schemaVersion, DEVFLOW_MIGRATIONS.at(-1)?.id);
    assert.equal(snapshot.checksumSha256, sha256(snapshot.dbPath));
    assert.ok(snapshot.createdAt);
    assert.equal(snapshot.source.fileSizeBytes > 0, true);

    const copy = new Database(snapshot.dbPath, { readonly: true });
    const githubTokenRow = copy.prepare("SELECT value FROM settings WHERE key='githubToken'").get() as { value?: string } | undefined;
    assert.equal(githubTokenRow?.value, '');
    copy.close();
    assert.equal(getRecoveryStatus({ backupsDir }).lastVerifiedGoodBackup?.id, snapshot.id);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects checksum mismatch before restore drill touches the copied database', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-backup-checksum-'));
  const backupsDir = path.join(root, 'backups');
  const { db, dbPath } = makeDb(root, 'active.db');
  try {
    const snapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: dbPath, backupsDir });
    fs.appendFileSync(snapshot.dbPath, Buffer.from('corruption-after-snapshot'));
    const verification = verifyBackupFile({ backupPath: snapshot.dbPath, expectedChecksum: snapshot.checksumSha256 });
    assert.equal(verification.ok, false);
    assert.equal(verification.code, 'BACKUP_CHECKSUM_MISMATCH');

    const drill = await runRestoreDrill({
      backupPath: snapshot.dbPath,
      expectedChecksum: snapshot.checksumSha256,
      activeDbPath: dbPath,
      tempRoot: path.join(root, 'drills'),
      backupsDir,
    });
    assert.equal(drill.ok, false);
    assert.equal(drill.code, 'BACKUP_CHECKSUM_MISMATCH');
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects corrupted SQLite and unknown newer migration ids with actionable codes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-backup-invalid-'));
  try {
    const corrupt = path.join(root, 'corrupt.db');
    fs.writeFileSync(corrupt, 'not sqlite');
    assert.equal(verifyBackupFile({ backupPath: corrupt }).code, 'BACKUP_SQLITE_CORRUPT');

    const { db, dbPath } = makeDb(root, 'future.db');
    db.prepare("INSERT INTO migrations (id, name) VALUES ('999-future', '999-future')").run();
    db.close();
    const future = verifyBackupFile({ backupPath: dbPath });
    assert.equal(future.ok, false);
    assert.equal(future.code, 'BACKUP_SCHEMA_INCOMPATIBLE');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retention pruning is bounded and preserves newest verified snapshots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-backup-retention-'));
  const backupsDir = path.join(root, 'backups');
  const { db, dbPath } = makeDb(root, 'active.db');
  try {
    const ids: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const snapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: dbPath, backupsDir, retention: 3, now: new Date(Date.UTC(2026, 7, 9, 1, 0, index)) });
      ids.push(snapshot.id);
    }
    const manifests = fs.readdirSync(backupsDir).filter((name) => name.endsWith('.json') && name.startsWith('snapshot-'));
    assert.equal(manifests.length, 3);
    assert.equal(manifests.some((name) => name.includes(ids.at(-1)!)), true);
    assert.equal(manifests.some((name) => name.includes(ids.at(-2)!)), true);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('restore drill migrates an older compatible copy in isolation and never changes active DB bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-backup-drill-'));
  const backupsDir = path.join(root, 'backups');
  const { db: activeDb, dbPath: activePath } = makeDb(root, 'active.db');
  const activeHashBefore = sha256(activePath);
  const { db: oldDb, dbPath: oldPath } = makeDb(root, 'old.db', 3);
  oldDb.close();
  try {
    const drill = await runRestoreDrill({ backupPath: oldPath, activeDbPath: activePath, tempRoot: path.join(root, 'drills'), backupsDir });
    assert.equal(drill.ok, true);
    assert.equal(drill.migrated, true);
    assert.equal(drill.schemaVersion, DEVFLOW_MIGRATIONS.at(-1)?.id);
    assert.equal(drill.counts.projects, 1);
    assert.equal(sha256(activePath), activeHashBefore);
    assert.equal(getRecoveryStatus({ backupsDir }).lastRestoreDrill?.ok, true);
  } finally {
    activeDb.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
