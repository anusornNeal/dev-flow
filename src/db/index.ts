import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDevFlowDbPath } from '../lib/devFlowPaths.js';

let _db: InstanceType<typeof Database> | null = null;

function getDb(): InstanceType<typeof Database> {
  if (!_db) {
    const dbPath = getDevFlowDbPath();
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
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
