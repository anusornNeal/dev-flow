import { runMigrations } from './runner.js';
import { initMigration } from './001-init.js';
import { persistenceHardeningMigration } from './002-persistence-hardening.js';
import db from '../index.js';

export function executeAllMigrations() {
  runMigrations(db, [initMigration, persistenceHardeningMigration]);
}
