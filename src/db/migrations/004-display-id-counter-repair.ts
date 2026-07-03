import type { Migration } from './runner.js';
import { repairDisplayIdsForPrefix } from '../../server/repositories/taskRepository.js';

export const displayIdCounterRepairMigration: Migration = {
  id: '004-display-id-counter-repair',
  up: (db) => {
    repairDisplayIdsForPrefix('DVF', db);
  },
};
