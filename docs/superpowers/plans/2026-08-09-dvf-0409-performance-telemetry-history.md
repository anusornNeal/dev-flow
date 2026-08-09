# DVF-0409 Performance Telemetry History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist aggregate DevFlow MCP/tool performance history in SQLite and expose bounded current-vs-baseline comparisons without slowing individual tool calls.

**Architecture:** Keep `mcpToolMonitor` as the in-memory hot path. Periodically materialize aggregate tool snapshots into a dedicated SQLite repository, keyed by time window/tool/project scope/contract revision/app revision, then let workflow health read recent persisted baselines. Persistence stores aggregate numbers only; no raw arguments, prompt/file content, token values, secrets, input hashes, or machine paths.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, node:test, existing DevFlow migration runner and MCP monitor services.

## Global Constraints

- SQLite is the historical source of truth; the current rolling monitor remains in memory.
- Do not persist raw tool arguments, prompts, file contents, tokens, secrets, input hashes, or absolute local paths.
- Writes are amortized/batched and never performed for every tool call.
- Retention/compaction is deterministic and bounded.
- Historical reads remain compact and must not materially slow workflow health.
- Existing live diagnostics remain backward compatible.
- The pre-existing workspace baseline has an unrelated typecheck failure at `tests/server/authoringSkillContent.test.ts:91`; do not modify that file in this card.

---

### Task 1: SQLite telemetry schema and repository

**Files:**
- Create: `src/db/migrations/008-performance-telemetry-history.ts`
- Modify: `src/db/migrations/index.ts`
- Create: `src/server/repositories/performanceTelemetryRepository.ts`
- Create: `tests/server/performanceTelemetryRepository.test.ts`

**Interfaces:**
- `persistPerformanceSnapshots(snapshots, options?)` inserts aggregate rows transactionally and runs deterministic retention.
- `getPerformanceBaseline(query)` returns compact weighted aggregate history or `insufficient-samples`.
- `compactPerformanceHistory(options?)` deletes rows outside retention and trims oldest overflow rows.

- [ ] **Step 1: Write failing repository tests** covering schema migration, aggregate-only persistence, restart visibility through a fresh module/connection lifecycle, deterministic age/max-row retention, and baseline aggregation.
- [ ] **Step 2: Run focused repository test and confirm RED** because migration/repository exports do not exist.
- [ ] **Step 3: Add migration** for `performance_telemetry_snapshots` with indexed time/tool/scope/revision columns and numeric aggregate fields only.
- [ ] **Step 4: Add repository implementation** with a transaction for batch inserts, 30-day retention, a 5,000-row hard cap, and a minimum baseline sample threshold of 5 calls.
- [ ] **Step 5: Run focused repository test and confirm GREEN.**

### Task 2: Amortized snapshot handoff from MCP monitor

**Files:**
- Modify: `src/server/services/mcpToolMonitor.ts`
- Modify: `tests/server/mcpToolMonitor.test.ts`

**Interfaces:**
- `recordToolCall()` remains synchronous/in-memory and must not write SQLite for each call.
- `flushPerformanceTelemetry(options?)` persists one aggregate snapshot per tool/scope for the pending interval.
- `getPerformanceHistoryComparison(options?)` returns structured `insufficient-samples`, `stable`, `regression`, or `improvement` rows.

- [ ] **Step 1: Add failing monitor tests** proving calls are aggregated without raw args, flush persists aggregate metrics, revision/scope fields are populated without local paths, and comparison distinguishes insufficient sample from regression/improvement.
- [ ] **Step 2: Run focused monitor test and confirm RED.**
- [ ] **Step 3: Implement minimal pending-bucket accumulation and timed flush** with a default 60-second interval; flush is triggered opportunistically from diagnostics/summary reads rather than individual call persistence.
- [ ] **Step 4: Resolve contract revision from `DEVFLOW_CONTRACT_VERSION`; resolve app revision once per process from `DEVFLOW_APP_REVISION`/`GIT_COMMIT` or a cached `git rev-parse HEAD` fallback.**
- [ ] **Step 5: Implement comparison** using current in-memory metrics versus persisted baseline, requiring at least 5 calls in both sides and classifying p95 deltas at ±15%.
- [ ] **Step 6: Run monitor + repository tests and confirm GREEN.**

### Task 3: Workflow-health historical comparison

**Files:**
- Modify: `src/server/services/workflowHealthService.ts`
- Modify: `tests/server/workflowHealthService.test.ts`

**Interfaces:**
- `diagnostics.performance.history` exposes compact comparison rows and counts.
- Existing `diagnostics.performance` SLO fields remain compatible.

- [ ] **Step 1: Add failing workflow-health tests** for current-vs-baseline output, insufficient-sample behavior, and regression recommendation wording.
- [ ] **Step 2: Run focused workflow-health test and confirm RED.**
- [ ] **Step 3: Integrate historical comparison** without changing existing live SLO evaluation; add a recommendation only for true historical regressions.
- [ ] **Step 4: Run workflow-health + monitor + repository tests and confirm GREEN.**

### Task 4: Verification and delivery

**Files:**
- Review all files changed above.

- [ ] **Step 1: Run focused tests** for repository, MCP monitor, workflow health, and migration behavior.
- [ ] **Step 2: Run `typecheck`** and record the existing unrelated baseline failure separately if it remains unchanged.
- [ ] **Step 3: Review diff** for accidental raw-payload/path persistence, hot-path SQLite writes, unrelated edits, and oversized modules.
- [ ] **Step 4: Commit scoped changes** with a DVF-0409 message.
- [ ] **Step 5: Sync task evidence and move through review/done according to DevFlow gates; do not push unless explicitly authorized by the user or required by an existing project rule that the user has overridden for this local workflow.
