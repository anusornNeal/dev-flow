import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = process.env.DEVFLOW_DB_PATH || path.join(process.cwd(), 'data', 'devflow.db');
const SCHEMA_PATH = path.join(process.cwd(), 'src', 'db', 'schema.sql');

// Ensure data directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize database
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Read and execute schema
const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf8');
db.exec(schemaSql);

export default db;
