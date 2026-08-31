import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import Database from 'better-sqlite3';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-settings-import-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'data', 'devflow.db');
fs.mkdirSync(path.dirname(process.env.DEVFLOW_DB_PATH), { recursive: true });

const { DEVFLOW_MIGRATIONS } = await import('../../src/db/migrations/index.js');
const { runMigrations } = await import('../../src/db/migrations/runner.js');
const db = (await import('../../src/db/index.js')).default;
const { registerSettingsRoutes } = await import('../../src/server/routes/settings.js');
runMigrations(db, [...DEVFLOW_MIGRATIONS]);

const app = express();
app.use(express.json());
registerSettingsRoutes(app, { state: { countersCache: {} }, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind settings import test server.');
const baseUrl = `http://127.0.0.1:${address.port}`;

test('database import stages the backup and leaves the active connection-owned database untouched', async () => {
  const backupPath = path.join(tempRoot, 'uploaded-backup.db');
  const backupDb = new Database(backupPath);
  runMigrations(backupDb, [...DEVFLOW_MIGRATIONS]);
  backupDb.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('imported-project', 'Imported project', '2026-08-31');
  backupDb.close();

  const response = await fetch(`${baseUrl}/api/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: fs.readFileSync(backupPath),
  });
  const body = await response.json() as Record<string, any>;

  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.success, true);
  assert.equal(body.restartRequired, true);

  const activeDb = new Database(process.env.DEVFLOW_DB_PATH!, { readonly: true });
  assert.equal(activeDb.prepare('SELECT 1 FROM projects WHERE id = ?').get('imported-project'), undefined);
  activeDb.close();

  const pendingFiles = fs.readdirSync(path.dirname(process.env.DEVFLOW_DB_PATH!))
    .filter((name) => name.startsWith('devflow-import-pending-') && name.endsWith('.db'));
  assert.equal(pendingFiles.length, 1);
  db.close();
});

test.after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  try { db.close(); } catch {}
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
