import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';
import { getDevFlowAppRoot, getDevFlowDataDir, getDevFlowUploadsDir, getDevFlowBackupsDir, getDevFlowDbPath } from '../src/lib/devFlowPaths';

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

async function runBackup() {
  const dataDir = getDevFlowDataDir();
  const dbFile = getDevFlowDbPath();
  const uploadsDir = getDevFlowUploadsDir();
  const backupsDir = getDevFlowBackupsDir();

  if (!fs.existsSync(dbFile)) {
    console.error('No database found to backup at', dbFile);
    process.exit(1);
  }

  fs.mkdirSync(backupsDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bundleDir = path.join(backupsDir, `devflow-backup-${timestamp}`);

  fs.mkdirSync(bundleDir, { recursive: true });
  const bundleDb = path.join(bundleDir, 'devflow.db');
  const bundleUploads = path.join(bundleDir, 'uploads');
  const bundleManifest = path.join(bundleDir, 'manifest.json');

  console.log(`Starting backup of ${dbFile} -> ${bundleDir} ...`);

  const db = new Database(dbFile);
  let dbOk = false;
  try {
    await db.backup(bundleDb);
    dbOk = true;
    console.log(`[backup] SQLite backup written: ${bundleDb}`);
  } catch (error) {
    console.error('[backup] SQLite backup failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }

  let uploadsCopied = { files: 0, bytes: 0 };
  if (fs.existsSync(uploadsDir)) {
    uploadsCopied = copyDirRecursive(uploadsDir, bundleUploads);
    console.log(`[backup] Uploads copied: ${uploadsCopied.files} file(s), ${uploadsCopied.bytes} bytes`);
  } else {
    fs.mkdirSync(bundleUploads, { recursive: true });
    console.log('[backup] No uploads directory existed, created empty uploads/ in bundle');
  }

  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    dbFile: 'devflow.db',
    includesUploads: true,
    app: 'dev-flow',
    counts: {
      uploadsFiles: uploadsCopied.files,
      uploadsBytes: uploadsCopied.bytes,
    },
  };
  fs.writeFileSync(bundleManifest, JSON.stringify(manifest, null, 2), 'utf8');

  if (dbOk) {
    console.log(`[backup] Backup completed: ${bundleDir}`);
    console.log(`[backup] manifest: ${bundleManifest}`);
  }
}

runBackup();
