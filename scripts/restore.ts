import path from 'path';
import fs from 'fs';
import readline from 'readline';
import Database from 'better-sqlite3';

async function runRestore() {
  const args = process.argv.slice(2);
  const backupFileArg = args[0];

  if (!backupFileArg) {
    console.error('Usage: npm run restore <path-to-backup-db>');
    process.exit(1);
  }

  const backupFile = path.resolve(backupFileArg);
  if (!fs.existsSync(backupFile)) {
    console.error(`Backup file not found: ${backupFile}`);
    process.exit(1);
  }

  const dataDir = path.join(process.cwd(), 'data');
  const dbFile = process.env.DEVFLOW_DB_PATH || path.join(dataDir, 'devflow.db');
  console.log(`Target database: ${dbFile}`);

  // Validate backup file
  let isValid = false;
  const counts: Record<string, number> = {};
  try {
    const tempDb = new Database(backupFile);
    const requiredTables = ['projects', 'tasks', 'settings', 'skills', 'counters'];
    const tables = tempDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const tableNames = tables.map(t => t.name);
    isValid = requiredTables.every(t => tableNames.includes(t));
    
    if (isValid) {
      counts.projects = tempDb.prepare('SELECT COUNT(*) AS c FROM projects').get().c;
      counts.tasks = tempDb.prepare('SELECT COUNT(*) AS c FROM tasks').get().c;
      counts.skills = tempDb.prepare('SELECT COUNT(*) AS c FROM skills').get().c;
    }
    tempDb.close();
  } catch (err) {
    console.error('Validation failed:', err);
  }

  if (!isValid) {
    console.error('Invalid DevFlow database file. Required tables are missing or file is corrupted.');
    process.exit(1);
  }
  
  console.log(`Backup valid. Found ${counts.projects || 0} projects, ${counts.tasks || 0} tasks, ${counts.skills || 0} skills.`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query: string): Promise<string> => new Promise(resolve => rl.question(query, resolve));

  const answer = await question(`Are you sure you want to restore from ${backupFile}? This will overwrite your current DevFlow database.\nIMPORTANT: Please ensure DevFlow is NOT running before continuing.\n(yes/no): `);
  
  if (answer.toLowerCase() !== 'yes') {
    console.log('Restore cancelled.');
    rl.close();
    process.exit(0);
  }
  rl.close();

  if (fs.existsSync(dbFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyBackup = path.join(dataDir, `devflow-safety-${timestamp}.db`);
    console.log(`Creating safety backup of current DB to ${safetyBackup}...`);
    try {
      const db = new Database(dbFile);
      await db.backup(safetyBackup);
      db.close();
      console.log('Safety backup created.');
    } catch (e) {
      console.error('Failed to create safety backup. Restore cancelled.', e);
      process.exit(1);
    }
  }

  try {
    fs.copyFileSync(backupFile, dbFile);
    
    const walFile = dbFile + '-wal';
    const shmFile = dbFile + '-shm';
    if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
    if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

    console.log('Restore completed successfully. Please restart DevFlow.');
  } catch (error) {
    console.error('Failed to restore database. Your safety backup is preserved.', error);
    process.exit(1);
  }
}

runRestore();
