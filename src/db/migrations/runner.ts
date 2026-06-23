import db from '../index.js';

export interface Migration {
  id: string;
  up: (db: any) => void;
  down?: (db: any) => void;
}

export function runMigrations(migrations: Migration[]) {
  db.prepare(`
    CREATE TABLE IF NOT EXISTS migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  const appliedIds = new Set(
    (db.prepare('SELECT id FROM migrations').all() as any[]).map(r => r.id)
  );

  const pending = migrations.filter(m => !appliedIds.has(m.id));
  
  const runTransaction = db.transaction((mig: Migration) => {
    mig.up(db);
    db.prepare('INSERT INTO migrations (id, name) VALUES (?, ?)').run(mig.id, mig.id);
  });

  for (const mig of pending) {
    runTransaction(mig);
    console.log(`Applied migration: ${mig.id}`);
  }
}
