import { runMigrations } from './runner.js';
import { initMigration } from './001-init.js';
import { persistenceHardeningMigration } from './002-persistence-hardening.js';
import { taskBugThreadsMigration } from './003-task-bug-threads.js';
import { displayIdCounterRepairMigration } from './004-display-id-counter-repair.js';
import { taskWorkflowEvidenceMigration } from './005-task-workflow-evidence.js';
import { taskBoardArchiveMigration } from './006-task-board-archive.js';
import { taskDisplayIdIndexMigration } from './007-task-display-id-index.js';
import { mcpToolJobsMigration } from './008-mcp-tool-jobs.js';
import db from '../index.js';

export function executeAllMigrations() {
  runMigrations(db, [
    initMigration,
    persistenceHardeningMigration,
    taskBugThreadsMigration,
    displayIdCounterRepairMigration,
    taskWorkflowEvidenceMigration,
    taskBoardArchiveMigration,
    taskDisplayIdIndexMigration,
    mcpToolJobsMigration,
  ]);
}
