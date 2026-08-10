# DVF-0470 Verification Supersession and Lag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make verification supersession revision-aware, restart-safe, and bounded by per-series verification lag without discarding required RED evidence.

**Architecture:** Extend the existing DVF-0446 queue policy instead of creating a second scheduler. Verification requests carry immutable series/candidate/generation/evidence intent; job lifecycle persistence records supersession so recovery cannot requeue obsolete work. The service computes lag from the latest accepted GREEN generation per series and applies configurable warn/block thresholds while keeping review/docs/safe cleanup possible.

**Tech Stack:** TypeScript, Node.js test runner, SQLite migrations, existing DevFlow MCP job queue/recovery services.

## Global Constraints

- Preserve required historical RED evidence.
- Do not spawn stale queued GREEN/focused work that cannot satisfy a current gate.
- Cancel running work only when cooperative cancellation is available and materially useful.
- Persist terminal supersession so restart/recovery cannot resurrect obsolete verification.
- Keep thresholds conservative and configurable; default behavior must remain compatible for callers that do not opt into generation-aware verification.
- Run focused queue/recovery tests first, then typecheck once at the end.
- Do not push.

---

### Task 1: Add failing lifecycle and lag tests

**Files:**
- Test: `tests/server/mcpToolJobQueue.test.ts`

**Interfaces:**
- Consumes: `enqueueToolJob`, `getToolJobStatus`, `getQueueMetrics`, durable recovery test hook.
- Produces: regression contracts for superseded queued work, required RED preservation, lag warning/block behavior, and restart-safe recovery.

- [ ] Add a fixture where generation 1 GREEN is queued, generation 2 supersedes it, and generation 1 never starts.
- [ ] Add a required RED fixture proving generation advancement does not supersede it.
- [ ] Add lag fixtures with accepted GREEN generation + configurable warn/block thresholds and assert structured diagnostics/errors.
- [ ] Add recovery assertion that a persisted superseded/cancelled job is absent from recoverable work.
- [ ] Run the focused queue test file and confirm the new tests fail for missing generation/persistence semantics.

### Task 2: Persist verification lifecycle metadata

**Files:**
- Create: `src/db/migrations/015-mcp-tool-job-verification-lifecycle.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/server/repositories/mcpToolJobRepository.ts`

**Interfaces:**
- Produces persisted fields for verification series/candidate/generation/evidence intent, superseded-by candidate/generation, and superseded timestamp.
- Recovery queries must exclude superseded jobs even if legacy cancellation metadata is incomplete.

- [ ] Add migration columns idempotently.
- [ ] Extend `McpToolJob`, row mapping, lifecycle persistence, and creation to store verification metadata derived from immutable job args.
- [ ] Add a repository helper that atomically marks a queued/running job superseded and terminal.
- [ ] Harden `listRecoverableJobs` / recovery requeue so superseded jobs cannot reactivate.
- [ ] Run the focused queue test file until persistence/recovery assertions pass.

### Task 3: Add revision-aware supersession and lag backpressure

**Files:**
- Modify: `src/server/services/mcpToolJobService.ts`

**Interfaces:**
- Verification policy accepts optional `verificationGeneration`, `verificationEvidenceIntent` (`red-required`, `red-deferred`, `green`, `focused`), `acceptedGreenGeneration`, `verificationLagWarnThreshold`, and `verificationLagBlockThreshold`.
- `getQueueMetrics()` exposes superseded/saved executions plus lag warning/block counters and current lag samples.

- [ ] Replace in-memory-only supersession terminalization with the repository helper while keeping current cooperative running cancellation.
- [ ] Supersede only older generations in the same series; required RED is never eligible.
- [ ] Track lag as `verificationGeneration - acceptedGreenGeneration`, defaulting to zero/legacy behavior when absent.
- [ ] Warn at medium lag via diagnostics/telemetry; reject excessive speculative behavioral verification with `VERIFICATION_LAG_BACKPRESSURE` and structured details.
- [ ] Count saved queued executions and lag/backpressure events.
- [ ] Ensure init/recovery does not rebuild superseded entries as active.
- [ ] Run focused queue/recovery tests to GREEN.

### Task 4: Surface diagnostics and final verification

**Files:**
- Modify only if needed: `src/server/services/mcpToolMonitor.ts`

**Interfaces:**
- `getDevFlowDiagnostics()` must surface the queue metrics returned by `getJobMetrics()` without losing supersession/lag fields.

- [ ] Verify monitor output includes new metrics; change only if current pass-through drops them.
- [ ] Run `tests/server/mcpToolJobQueue.test.ts`.
- [ ] Run related verification candidate/recovery tests if touched behavior overlaps.
- [ ] Run typecheck once.
- [ ] Review diff for scope, then commit and finalize into local `develop`.
