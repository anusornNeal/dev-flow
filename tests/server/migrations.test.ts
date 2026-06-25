import test from 'node:test';
import assert from 'node:assert';
import db from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';

test('Migration runner creates migrations table and applies pending scripts', () => {
  // Setup isolated memory DB
  db.prepare('DROP TABLE IF EXISTS migrations').run();
  db.prepare('DROP TABLE IF EXISTS test_table').run();
  
  const testMigrations = [
    { id: '001-test', up: (db: any) => db.prepare('CREATE TABLE test_table (id TEXT)').run() }
  ];
  
  runMigrations(db, testMigrations);
  
  const applied = db.prepare('SELECT * FROM migrations').all() as any[];
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].name, '001-test');
});
