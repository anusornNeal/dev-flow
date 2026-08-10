# DVF-0473 Verification Resource Profiling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Learn bounded, machine-specific verification cost profiles from actual command executions without changing scheduler admission policy.

**Architecture:** Add portable machine/system/process-tree sampling primitives in `platformRuntime`, a bounded in-memory profile service with conservative no-history estimates and robust recency-weighted learning, then instrument project-command cache misses. Diagnostics expose predicted-vs-actual error and profile uncertainty; the scheduler remains unchanged.

**Tech Stack:** TypeScript, Node.js `os`/`child_process`, `node:test`, existing project-command descriptors and DevFlow diagnostics.

## Global Constraints

- Profiling only: do not change scheduler capacity/admission in this card.
- Never expose absolute developer/workspace paths in machine/profile identity.
- Sampling must be bounded and optional: short commands should not pay process-tree polling overhead.
- Windows and macOS/Linux must degrade safely when detailed process-tree signals are unavailable.
- Failed/timed-out and outlier samples remain auditable but cannot immediately distort learned admission cost.
- Shared-resource descriptor metadata must flow through the profile unchanged.
- Do not push.

---

### Task 1: Portable machine and resource sampling RED/GREEN

**Files:**
- Modify: `src/lib/platformRuntime.ts`
- Modify: `tests/lib/platformRuntime.test.ts`

- [ ] Add failing tests for stable path-free machine profile identity, system CPU/memory deltas, POSIX descendant accounting, Windows main-process fallback and unavailable-signal degradation.
- [ ] Implement deterministic machine profile hashing from platform/arch/runtime/CPU-count/model hash/memory bucket.
- [ ] Implement system resource snapshots and deltas.
- [ ] Implement bounded process-tree sampling: full descendant accounting from `ps` on macOS/Linux, safe `tasklist` main-process fallback on Windows, unsupported result elsewhere/failure.
- [ ] Run focused platform tests GREEN.

### Task 2: Bounded learned verification profiles RED/GREEN

**Files:**
- Create: `src/server/services/verificationResourceProfileService.ts`
- Create: `tests/server/verificationResourceProfileService.test.ts`

- [ ] Add failing tests for no-history conservative defaults, repository/semantic/machine key separation, recency learning, bounded retention, failed-sample isolation and outlier robustness.
- [ ] Store bounded recent samples per profile and bounded profile count.
- [ ] Use descriptor cost/class only for cold-start defaults; never repository-name constants.
- [ ] Learn from successful measured samples with robust clipping and recency weighting; expose expected + upper-bound cost and confidence/sample counts.
- [ ] Track predicted-vs-actual error telemetry.
- [ ] Run focused profile tests GREEN.

### Task 3: Instrument project command executions

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Modify: `tests/server/projectCommandService.test.ts`

- [ ] Reuse resolved command descriptor semantic key/shared resources for profile identity.
- [ ] On cache misses, capture start/end system samples for sync and async commands.
- [ ] For async commands lasting beyond a bounded interval, sample child process resources without delaying short commands; aggregate max CPU/RSS/process count.
- [ ] Record success/failure/timeout observations and return resource-profile prediction/actual/error metadata in command results.
- [ ] Do not record cache hits as new executions.
- [ ] Run focused project-command tests GREEN.

### Task 4: Diagnostics and final verification

**Files:**
- Modify: `src/server/services/mcpToolMonitor.ts`
- Modify: `tests/server/mcpToolMonitor.test.ts`

- [ ] Expose bounded verification resource profile diagnostics including sample counts, confidence and prediction error summaries.
- [ ] Run platform/profile/project-command/monitor focused tests.
- [ ] Run typecheck once after final code changes.
- [ ] Review diff, commit scoped changes, finalize into local `develop`, and continue the board loop.
