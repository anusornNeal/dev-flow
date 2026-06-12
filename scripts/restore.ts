import path from 'path';
import fs from 'fs';
import readline from 'readline';

async function runRestore() {
  const args = process.argv.slice(2);
  const backupFileArg = args[0];

  if (!backupFileArg) {
    console.error('Usage: npm run restore <path-to-backup-db>');
    process.exit(1);
  }

  const backupFile = path.resolve(backupFileArg);
  if (!fs.existsSync(backupFile)) {
    console.error(\Backup file not found: \\);
    process.exit(1);
  }

  const dataDir = path.join(process.cwd(), 'data');
  const dbFile = path.join(dataDir, 'devflow.db');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const question = (query: string): Promise<string> => new Promise(resolve => rl.question(query, resolve));

  const answer = await question(\Are you sure you want to restore from \? This will overwrite your current DevFlow database. (yes/no): \);
  
  if (answer.toLowerCase() !== 'yes') {
    console.log('Restore cancelled.');
    rl.close();
    process.exit(0);
  }
  rl.close();

  if (fs.existsSync(dbFile)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safetyBackup = path.join(dataDir, \devflow-safety-\.db\);
    console.log(\Creating safety backup of current DB to \...\);
    try {
      const Database = require('better-sqlite3');
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
    console.log('Restore completed successfully. Please restart DevFlow.');
  } catch (error) {
    console.error('Failed to restore database. Your safety backup is preserved.', error);
    process.exit(1);
  }
}

runRestore();
