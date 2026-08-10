import { runMigrations } from './runner.js';
import { initMigration } from './001-init.js';
import { persistenceHardeningMigration } from './002-persistence-hardening.js';
import { taskBugThreadsMigration } from './003-task-bug-threads.js';
import { displayIdCounterRepairMigration } from './004-display-id-counter-repair.js';
import { taskWorkflowEvidenceMigration } from './005-task-workflow-evidence.js';
import { taskBoardArchiveMigration } from './006-task-board-archive.js';
import { taskDisplayIdIndexMigration } from './007-task-display-id-index.js';
import { mcpToolJobsMigration } from './008-mcp-tool-jobs.js';
import { performanceTelemetryHistoryMigration } from './008-performance-telemetry-history.js';
import { executionSessionsMigration } from './010-execution-sessions.js';
import { mcpToolJobLeaseFencingMigration } from './011-mcp-tool-job-lease-fencing.js';
import { taskClaimsMigration } from './012-task-claims.js';
import { projectGitWorkflowPolicyMigration } from './013-project-git-workflow-policy.js';
import { mcpLatencyTelemetryMigration } from './014-mcp-latency-telemetry.js';
import { mcpToolJobVerificationLifecycleMigration } from './015-mcp-tool-job-verification-lifecycle.js';
import db from '../index.js';

export const DEVFLOW_MIGRATIONS = [
  initMigration,
  persistenceHardeningMigration,
  taskBugThreadsMigration,
  displayIdCounterRepairMigration,
  taskWorkflowEvidenceMigration,
  taskBoardArchiveMigration,
  taskDisplayIdIndexMigration,
  mcpToolJobsMigration,
  performanceTelemetryHistoryMigration,
  executionSessionsMigration,
  mcpToolJobLeaseFencingMigration,
  taskClaimsMigration,
  projectGitWorkflowPolicyMigration,
  mcpLatencyTelemetryMigration,
  mcpToolJobVerificationLifecycleMigration,
] as const;

export function executeAllMigrations() {
  runMigrations(db, [...DEVFLOW_MIGRATIONS]);
}
