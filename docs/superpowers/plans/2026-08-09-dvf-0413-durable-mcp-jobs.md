# DVF-0413 Durable MCP Tool Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MCP tool-job lifecycle state durable in SQLite with atomic transitions, crash-safe leases, deterministic startup recovery, persistent cancellation, artifact metadata, and durable health metrics while preserving existing job APIs.

**Architecture:** SQLite becomes the source of truth for job metadata and lifecycle. Existing per-job directories remain bounded artifact storage for logs/results/patches, referenced by durable rows. The repository owns atomic compare-and-set transitions and leases; the runner registry declares recovery policy; the service reconstructs recoverable queue entries at startup and derives metrics from durable rows rather than process memory alone.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, node:test, existing DevFlow scheduler/job APIs.

## Global Constraints

- Preserve existing MCP job API response shapes for callers.
- Keep logs/results as bounded artifact files where useful; do not move large payloads into SQLite.
- Never persist raw secrets; continue redacting job args.
- Use focused tests plus typecheck. The current worktree baseline typecheck is blocked by the unrelated DVF-0417 parsing defect in `tests/server/authoringSkillContent.test.ts`.
- Work only in the managed session worktree and do not push.

---

### Task 1: Durable SQLite job schema and repository

**Files:**
- Create: `src/db/migrations/008-mcp-tool-jobs.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/server/repositories/mcpToolJobRepository.ts`
- Test: `tests/server/mcpToolJobRecovery.test.ts`

**Interfaces:**
- Produces `claimJob(jobId, workerId, leaseMs, now?)`, `heartbeatJob(jobId, workerId, leaseMs, now?)`, `requestJobCancellation(jobId, reason?)`, `listRecoverableJobs(now?)`, `getDurableJobMetrics(now?)`, and SQLite-backed existing `createJob/getJob/updateJobStatus/listRecentJobs`.
- `McpToolJob` gains optional lease/cancellation/recovery/artifact metadata while retaining existing fields.

- [ ] **Step 1: Write failing repository recovery tests** proving migration creates the table, queued/running/terminal rows survive cache reset/reload, competing claims are atomic, expired leases become recoverable, cancellation persists, and double terminal transitions are rejected.
- [ ] **Step 2: Run `test-dvf0413-recovery` and verify failures are caused by missing durable APIs/table.**
- [ ] **Step 3: Add migration 008** with `mcp_tool_jobs` columns for lifecycle timestamps, redacted args JSON, resource key, lease owner/expiry/heartbeat, cancellation timestamp/reason, recovery classification, artifact directory/result/log metadata, plus status/updated/lease indexes.
- [ ] **Step 4: Replace repository status-file source-of-truth with SQLite reads/writes.** Continue creating artifact directories/log files; status/input JSON may be maintained only as compatibility artifacts, never authoritative.
- [ ] **Step 5: Implement atomic transitions/claims.** Use `UPDATE ... WHERE status IN (...)` and worker/lease predicates; terminal rows must not transition again.
- [ ] **Step 6: Re-run recovery tests until green.**

### Task 2: Recovery policy contract and startup classification

**Files:**
- Modify: `src/server/services/mcpToolJobRunnerRegistry.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Test: `tests/server/mcpToolJobRecovery.test.ts`

**Interfaces:**
- Produces `getBuiltinToolJobRecoveryPolicy(toolName)` returning one of `retryable | interrupted` for stale running work, plus deterministic classification where queued => resumable, terminal => terminal, cancelled => terminal.
- Service startup consumes `listRecoverableJobs` and records `recoveryClassification` without executing cancelled work.

- [ ] **Step 1: Add failing restart tests** for queued, running retryable read, running non-idempotent edit, succeeded, failed, timed_out, and cancelled jobs; run recovery twice to prove idempotence.
- [ ] **Step 2: Run focused recovery test and verify RED.**
- [ ] **Step 3: Add explicit built-in recovery policy.** Read-only search is retryable; mutating/edit/git tools are interrupted unless an existing tool-specific policy proves safe.
- [ ] **Step 4: Change `initMcpToolJobs(state?)` startup recovery** so queued jobs classify resumable, stale retryable jobs classify retryable, unsafe stale jobs become failed/interrupted exactly once, and cancelled/terminal jobs remain unchanged.
- [ ] **Step 5: Re-run recovery tests until green.**

### Task 3: Lease-aware execution and cancellation

**Files:**
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/repositories/mcpToolJobRepository.ts`
- Test: `tests/server/mcpToolJobRecovery.test.ts`
- Test: `tests/server/mcpToolJobQueue.test.ts`

**Interfaces:**
- Runner claims a job before execution with a unique process worker id and bounded lease.
- Heartbeat timer renews the lease while running and is cleared in `finally`.
- `cancelToolJob` persists cancellation before invoking any in-process cancel callback.

- [ ] **Step 1: Add failing tests** that only one worker can claim, heartbeat extends ownership, cancelled durable work cannot be claimed/recovered, and a terminal result cannot be overwritten by a late worker.
- [ ] **Step 2: Run focused recovery test and verify RED.**
- [ ] **Step 3: Integrate atomic claim into `startJob`.** If claim fails, do not execute the runner; refresh state and continue queue processing.
- [ ] **Step 4: Add heartbeat renewal and cancellation checks** before terminal persistence.
- [ ] **Step 5: Run recovery and existing queue tests until green.**

### Task 4: Durable artifact metadata and health metrics

**Files:**
- Modify: `src/server/repositories/mcpToolJobRepository.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/services/workflowHealthService.ts`
- Test: `tests/server/mcpToolJobRecovery.test.ts`
- Test: `tests/server/workflowHealthService.test.ts`

**Interfaces:**
- Repository stores artifact directory plus result/log byte/checksum metadata after writes.
- `getDurableJobMetrics` returns queued/running/stale/recovered/failed counts and oldest lease age.
- `getQueueMetrics/getJobMetrics` merge live scheduler details with durable lifecycle counts.

- [ ] **Step 1: Add failing tests** proving result/log artifacts remain readable after durable reload and health metrics count durable queued/running/stale/recovered jobs even when in-memory queue maps are empty.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Persist artifact metadata** after result/log writes without storing large content in SQLite.
- [ ] **Step 4: Expose durable metrics** through existing queue/job diagnostics and workflow health without breaking current fields.
- [ ] **Step 5: Re-run focused tests until green.**

### Task 5: Verification and commit

**Files:**
- Review all task files above.

- [ ] **Step 1: Run `test-dvf0413-recovery`.** Expected PASS.
- [ ] **Step 2: Run `test-dvf0413-queue`.** Expected PASS.
- [ ] **Step 3: Run built-in `typecheck`.** If it still fails only at the known DVF-0417 parser defect, record that as an unrelated baseline blocker and ensure DVF-0413 files add no diagnostics before that blocker.
- [ ] **Step 4: Inspect git diff/status and confirm no unrelated changes.**
- [ ] **Step 5: Commit with `feat(mcp): persist durable tool job lifecycle`.**
