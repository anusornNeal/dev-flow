import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-database-import-'));
const dataDir = path.join(tempRoot, 'data');
const activeDbPath = path.join(dataDir, 'devflow.db');

const { DEVFLOW_MIGRATIONS } = await import('../../src/db/migrations/index.js');
const { runMigrations } = await import('../../src/db/migrations/runner.js');
const { applyPendingDatabaseImport, stageDatabaseImport } = await import('../../src/server/services/databaseImportService.js');

function createDatabase(filePath: string, projectName: string) {
  const database = new Database(filePath);
  runMigrations(database, [...DEVFLOW_MIGRATIONS]);
  database.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run(projectName, projectName, '2026-08-31');
  database.close();
}

test('staged import installs a verified database without carrying stale SQLite sidecars', () => {
  fs.mkdirSync(dataDir, { recursive: true });
  createDatabase(activeDbPath, 'existing-project');

  const uploadedPath = path.join(dataDir, 'uploaded-backup.db');
  createDatabase(uploadedPath, 'imported-project');
  fs.writeFileSync(`${activeDbPath}-wal`, 'stale WAL from the previous database');
  fs.writeFileSync(`${activeDbPath}-shm`, 'stale SHM from the previous database');

  const pendingPath = stageDatabaseImport({
    sourcePath: uploadedPath,
    dataDir,
    now: new Date('2026-08-31T07:20:26.475Z'),
  });
  fs.writeFileSync(`${pendingPath}-wal`, 'stale WAL beside staged import');
  fs.writeFileSync(`${pendingPath}-shm`, 'stale SHM beside staged import');

  assert.equal(fs.existsSync(uploadedPath), false);
  assert.equal(fs.existsSync(activeDbPath), true);

  const result = applyPendingDatabaseImport({ dataDir, targetDbPath: activeDbPath });

  assert.equal(result?.pendingPath, pendingPath);
  assert.equal(fs.existsSync(pendingPath), false);
  assert.equal(fs.existsSync(`${pendingPath}-wal`), false);
  assert.equal(fs.existsSync(`${pendingPath}-shm`), false);
  assert.equal(fs.existsSync(`${activeDbPath}-wal`), false);
  assert.equal(fs.existsSync(`${activeDbPath}-shm`), false);

  const database = new Database(activeDbPath, { readonly: true });
  assert.equal(database.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal((database.prepare('SELECT name FROM projects WHERE id = ?').get('imported-project') as { name: string }).name, 'imported-project');
  assert.equal(database.prepare('SELECT 1 FROM projects WHERE id = ?').get('existing-project'), undefined);
  database.close();
});
