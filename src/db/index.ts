import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDevFlowDbPath } from '../lib/devFlowPaths.js';

export function configureDatabaseConnection(connection: InstanceType<typeof Database>, options: { readonly?: boolean } = {}) {
  if (!options.readonly) connection.pragma('journal_mode = WAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  return connection;
}

export function openIsolatedDatabase(dbPath: string, options: { readonly?: boolean } = {}) {
  return configureDatabaseConnection(new Database(dbPath, { readonly: options.readonly === true }), options);
}

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (!_db) {
    const dbPath = getDevFlowDbPath();
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    _db = configureDatabaseConnection(new Database(dbPath));
  }
  return _db;
}

export function withDbTransaction<T>(work: () => T): T {
  return getDb().transaction(work)();
}

// Export a Proxy so all repositories can use `db.prepare(...)` etc. directly,
// but the underlying connection is opened lazily on first access.
const db = new Proxy({} as InstanceType<typeof Database>, {
  get(_target, prop) {
    return (getDb() as any)[prop];
  },
  set(_target, prop, value) {
    (getDb() as any)[prop] = value;
    return true;
  },
});

export default db;
