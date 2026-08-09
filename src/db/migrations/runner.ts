export interface Migration {
  id: string;
  up: (db: any) => void;
  down?: (db: any) => void;
}

export interface MigrationCompatibility {
  compatible: boolean;
  appliedIds: string[];
  pendingIds: string[];
  unknownIds: string[];
  currentVersion: string | null;
  latestSupportedVersion: string | null;
}

export function getAppliedMigrationIds(db: any): string[] {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='migrations'").get();
  if (!row) return [];
  return (db.prepare('SELECT id FROM migrations ORDER BY rowid ASC').all() as Array<{ id: string }>).map((entry) => entry.id);
}

export function inspectMigrationCompatibility(db: any, migrations: Migration[]): MigrationCompatibility {
  const supportedIds = migrations.map((migration) => migration.id);
  const supportedSet = new Set(supportedIds);
  const appliedIds = getAppliedMigrationIds(db);
  const unknownIds = appliedIds.filter((id) => !supportedSet.has(id));
  const appliedSet = new Set(appliedIds);
  return {
    compatible: unknownIds.length === 0,
    appliedIds,
    pendingIds: supportedIds.filter((id) => !appliedSet.has(id)),
    unknownIds,
    currentVersion: appliedIds.at(-1) || null,
    latestSupportedVersion: supportedIds.at(-1) || null,
  };
}

export function runMigrations(db: any, migrations: Migration[]) {
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
