import path from 'path';
import fs from 'fs';
import readline from 'readline';
import Database from 'better-sqlite3';
import { getDevFlowDataDir, getDevFlowDbPath, getDevFlowUploadsDir } from '../src/lib/devFlowPaths';

function copyDirRecursive(src: string, dest: string): { files: number; bytes: number } {
  if (!fs.existsSync(src)) return { files: 0, bytes: 0 };
  fs.mkdirSync(dest, { recursive: true });
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      const sub = copyDirRecursive(s, d);
      files += sub.files;
      bytes += sub.bytes;
    } else if (entry.isFile()) {
      const data = fs.readFileSync(s);
      fs.writeFileSync(d, data);
      files += 1;
      bytes += data.length;
    }
  }
  return { files, bytes };
}

function clearDir(dir: string) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      clearDir(p);
      fs.rmdirSync(p);
    } else {
      fs.unlinkSync(p);
    }
  }
}

interface ResolvedBackup {
  dbFile: string;
  uploadsDir: string | null;
  manifest: any | null;
  source: string;
}

function resolveBackup(input: string): ResolvedBackup | null {
  const abs = path.resolve(input);
  if (!fs.existsSync(abs)) return null;

  const stat = fs.statSync(abs);
  if (stat.isFile() && abs.endsWith('.db')) {
    return { dbFile: abs, uploadsDir: null, manifest: null, source: abs };
  }

  if (stat.isDirectory()) {
    const dbFile = path.join(abs, 'devflow.db');
    const manifestFile = path.join(abs, 'manifest.json');
    const uploadsDir = path.join(abs, 'uploads');
    if (!fs.existsSync(dbFile)) return null;
    let manifest: any = null;
    if (fs.existsSync(manifestFile)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      } catch {
        manifest = null;
      }
    }
    return {
      dbFile,
      uploadsDir: fs.existsSync(uploadsDir) ? uploadsDir : null,
      manifest,
      source: abs,
    };
  }

  return null;
}

async function runRestore() {
  const args = process.argv.slice(2);
  const inputArg = args[0];

  if (!inputArg) {
    console.error('Usage: npm run restore <path-to-backup-folder-or-db>');
    process.exit(1);
  }

  const backup = resolveBackup(inputArg);
  if (!backup) {
    console.error(`Backup not found or invalid: ${inputArg}`);
    process.exit(1);
  }

  const dataDir = getDevFlowDataDir();
  const dbFile = getDevFlowDbPath();
  const uploadsDir = getDevFlowUploadsDir();
  console.log(`[restore] Source: ${backup.source}`);
  console.log(`[restore] Target DB: ${dbFile}`);
  if (backup.uploadsDir) console.log(`[restore] Target Uploads: ${uploadsDir}`);

  // Validate DB
  const requiredTables = ['projects', 'tasks', 'counters', 'settings', 'skills', 'agent_runs', 'attachments'];
  let isValid = false;
  const counts: Record<string, number> = {};
  try {
    const tempDb = new Database(backup.dbFile, { readonly: true });
    const tables = tempDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map((t) => t.name);
    isValid = requiredTables.every((t) => tableNames.includes(t));
    if (isValid) {
      counts.projects = (tempDb.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
      counts.tasks = (tempDb.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
      counts.attachments = (tempDb.prepare('SELECT COUNT(*) AS c FROM attachments').get() as { c: number }).c;
    }
    tempDb.close();
  } catch (err) {
    console.error('[restore] Validation failed:', err);
  }

  if (!isValid) {
    console.error('[restore] Invalid DevFlow database. Required tables are missing or file is corrupted.');
    process.exit(1);
  }
  console.log(`[restore] Backup valid. Found ${counts.projects || 0} projects, ${counts.tasks || 0} tasks, ${counts.attachments || 0} attachments.`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const question = (query: string): Promise<string> => new Promise((resolve) => rl.question(query, resolve));
  const answer = await question(
    `Are you sure you want to restore from ${backup.source}?\nThis will overwrite your current DevFlow database${
      backup.uploadsDir ? ' and uploads folder' : ''
    }.\nIMPORTANT: Please ensure DevFlow is NOT running before continuing.\n(yes/no): `,
  );
  if (answer.toLowerCase() !== 'yes') {
    console.log('[restore] Restore cancelled.');
    rl.close();
    process.exit(0);
  }
  rl.close();

  // Safety backup of current DB
  if (fs.existsSync(dbFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyBackup = path.join(dataDir, `devflow-safety-${timestamp}.db`);
    console.log(`[restore] Creating safety backup of current DB to ${safetyBackup}...`);
    try {
      const db = new Database(dbFile);
      await db.backup(safetyBackup);
      db.close();
      console.log('[restore] Safety DB backup created.');
    } catch (e) {
      console.error('[restore] Failed to create safety backup. Restore cancelled.', e);
      process.exit(1);
    }
  }

  // Safety backup of uploads folder if it exists
  if (backup.uploadsDir && fs.existsSync(uploadsDir)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyUploads = path.join(dataDir, `uploads-safety-${timestamp}`);
    console.log(`[restore] Creating safety backup of current uploads to ${safetyUploads}...`);
    try {
      copyDirRecursive(uploadsDir, safetyUploads);
      console.log('[restore] Safety uploads backup created.');
    } catch (e) {
      console.error('[restore] Failed to create safety uploads backup. Restore cancelled.', e);
      process.exit(1);
    }
  }

  try {
    // Copy DB
    fs.copyFileSync(backup.dbFile, dbFile);
    const walFile = dbFile + '-wal';
    const shmFile = dbFile + '-shm';
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);
    console.log('[restore] DB copied.');

    // Restore uploads
    if (backup.uploadsDir) {
      clearDir(uploadsDir);
      const result = copyDirRecursive(backup.uploadsDir, uploadsDir);
      console.log(`[restore] Uploads restored: ${result.files} file(s), ${result.bytes} bytes`);
    }

    console.log('[restore] Restore completed successfully.');
    console.log('[restore] IMPORTANT: Please restart DevFlow now.');
  } catch (error) {
    console.error('[restore] Failed to restore. Your safety backups are preserved.', error);
    process.exit(1);
  }
}

runRestore();
