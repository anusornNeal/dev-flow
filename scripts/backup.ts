import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

async function runBackup() {
  const dataDir = path.join(process.cwd(), 'data');
  const dbFile = path.join(dataDir, 'devflow.db');

  if (!fs.existsSync(dbFile)) {
    console.error('No database found to backup at', dbFile);
    process.exit(1);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(dataDir, `devflow-backup-${timestamp}.db`);

  console.log(`Starting backup of ${dbFile}...`);
  const db = new Database(dbFile);
  
  try {
    await db.backup(backupFile);
    console.log(`Backup completed successfully: ${backupFile}`);
  } catch (error) {
    console.error('Backup failed:', error);
    process.exit(1);
  } finally {
    db.close();
  }
}

runBackup();
