import fs from 'fs';
import path from 'path';
import {
  getDevFlowAppRoot,
  getDevFlowDataDir,
  getDevFlowUploadsDir,
  getDevFlowBackupsDir,
} from '../src/lib/devFlowPaths';
import db from '../src/db/index';

const rootDir = getDevFlowAppRoot();
const envExamplePath = path.join(rootDir, '.env.example');
const envPath = path.join(rootDir, '.env');
const dataDir = getDevFlowDataDir();
const uploadsDir = getDevFlowUploadsDir();
const backupsDir = getDevFlowBackupsDir();
const legacyFiles = ['tasks.json', 'projects.json', 'counters.json'].map((name) => path.join(rootDir, name));

const messages: string[] = [];

function ensureDir(dir: string, label: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    messages.push(`Created ${label}: ${dir}`);
  } else {
    messages.push(`${label} already exists: ${dir}`);
  }
}

ensureDir(dataDir, 'Data directory');
ensureDir(uploadsDir, 'Uploads directory');
ensureDir(backupsDir, 'Backups directory');

if (!fs.existsSync(envPath) && fs.existsSync(envExamplePath)) {
  fs.copyFileSync(envExamplePath, envPath);
  messages.push('Created .env from .env.example');
} else if (fs.existsSync(envPath)) {
  messages.push('.env already exists');
} else {
  messages.push('No .env.example found, skipped .env bootstrap');
}

try {
  const tableCheck = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projects','tasks','counters','settings','skills','agent_runs','attachments')")
    .all() as Array<{ name: string }>;
  const found = new Set(tableCheck.map((r) => r.name));
  const required = ['projects', 'tasks', 'counters', 'settings', 'skills', 'agent_runs', 'attachments'];
  const missing = required.filter((t) => !found.has(t));
  if (missing.length === 0) {
    messages.push('SQLite schema is up to date (all 7 required tables present)');
  } else {
    messages.push(`SQLite schema missing tables: ${missing.join(', ')}`);
  }
} catch (e) {
  messages.push(`SQLite check failed: ${(e as Error).message}`);
}

const foundLegacy = legacyFiles.filter((p) => fs.existsSync(p));
if (foundLegacy.length > 0) {
  messages.push('Legacy JSON storage files detected.');
  for (const p of foundLegacy) messages.push(`  - ${path.basename(p)}`);
  messages.push('Run: npm run migrate:json');
} else {
  messages.push('No legacy JSON files found.');
}

messages.push('Setup completed.');

for (const message of messages) {
  console.log(`[setup] ${message}`);
}
