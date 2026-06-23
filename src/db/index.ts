import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { getDevFlowDbPath } from '../lib/devFlowPaths.js';

const DB_PATH = getDevFlowDbPath();

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

export default db;
