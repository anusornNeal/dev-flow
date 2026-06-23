import test from 'node:test';
import assert from 'node:assert';
import db from '../../src/db/index.js';
import { runMigrations } from '../../src/db/migrations/runner.js';

test('Migration runner creates migrations table and applies pending scripts', () => {
  // Setup isolated memory DB
  db.prepare('DROP TABLE IF EXISTS migrations').run();
  
  const testMigrations = [
    { id: '001-test', up: (db) => db.prepare('CREATE TABLE test_table (id TEXT)').run() }
  ];
  
  runMigrations(testMigrations);
  
  const applied = db.prepare('SELECT * FROM migrations').all();
  assert.strictEqual(applied.length, 1);
  assert.strictEqual(applied[0].name, '001-test');
});
