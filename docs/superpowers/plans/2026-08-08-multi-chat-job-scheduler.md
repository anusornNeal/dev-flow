# Multi-chat MCP Job Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make DevFlow responsive across multiple concurrent chats by allowing safe repository reads during long verification while preserving strict write safety and fair scheduling.

**Architecture:** Keep the existing MCP job service as the scheduler owner, but separate repository access mode (`read`, `verify`, `write`) and cost class from `JobKind`. Classify resolved project commands conservatively, add compatibility-aware queue scanning with a writer barrier, and let `apply_and_verify` atomically downgrade from `write` to `verify` after its mutation/diff phase. Extend queue/status metrics with blocker and age data, then benchmark a long verify plus concurrent reads.

**Tech Stack:** TypeScript, Node.js, Express/MCP job service, node:test, existing DevFlow command/verification services.

## Global Constraints

- Raw write concurrency stays exactly 1 per repository.
- Unknown/custom commands remain exclusive unless resolved metadata proves they are verification-safe.
- `read` and `verify` may overlap; `write` may overlap with neither.
- A queued writer is a barrier: newer same-repo reads/verifications cannot bypass it.
- `apply_and_verify` must use an atomic `write -> verify` downgrade, not release/reacquire.
- Different repositories remain independent.

---

### Task 1: Command access classification

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Test: `tests/server/projectCommandService.test.ts`

**Interfaces:**
- Produces: `ProjectCommandAccess = 'verify' | 'write'`
- Produces: `ProjectCommandDescriptor.access: ProjectCommandAccess`
- Consumes: existing resolved command source/category/command metadata.

- [ ] Add failing tests showing built-in verification package scripts resolve to `access: 'verify'`, repository-config commands with `category: test` resolve to `verify`, and unknown/non-test custom presets resolve to `write`.
- [ ] Run `tsx --test tests/server/projectCommandService.test.ts` and confirm the new assertions fail.
- [ ] Add `ProjectCommandAccess` and set `describeProjectCommand(...).access` conservatively from the resolved command: built-in package scripts in the allowed verification set and repository-config `category: test` are `verify`; all other repository-config commands are `write`.
- [ ] Re-run the targeted command-service tests and commit this slice.

### Task 2: Scheduler access modes, pools, and fairness

**Files:**
- Modify: `src/server/services/mcpToolJobService.ts`
- Test: `tests/server/mcpToolJobQueue.test.ts`

**Interfaces:**
- Produces: `ResourceAccessMode = 'read' | 'verify' | 'write'`
- Produces: `JobCostClass = 'light-read' | 'search' | 'verify' | 'write'`
- Produces: queue entry scheduler metadata (`accessMode`, `costClass`, `enqueuedAt`).
- Consumes: `describeProjectCommand(...).access` for `run_project_command`.

- [ ] Add failing tests for verify+read overlap, two-verification pool limit, write exclusion, compatible jobs before a writer starting without letting jobs after the writer bypass it, and different-repo independence.
- [ ] Add a failing telemetry assertion for `queueAgeMs`, `accessMode`, `costClass`, and blocker metadata on a queued job.
- [ ] Run `tsx --test tests/server/mcpToolJobQueue.test.ts` and confirm failures.
- [ ] Replace coarse `MAX_CONCURRENCY<JobKind>` scheduling with access/cost classification: light-read=8, search=4, verify=2, write=1.
- [ ] Replace `blockedResources` with compatibility-aware queue scanning. For each repository, jobs may start in order until the earliest queued writer becomes the barrier; newer same-repo jobs cannot pass that writer.
- [ ] Track blocker metadata by inspecting active incompatible jobs, pool saturation, and writer barriers. Surface it from `getToolJobStatus`, `getQueueMetrics`, and `getJobMetrics`.
- [ ] Re-run the scheduler tests and commit this slice.

### Task 3: Atomic lock downgrade for apply-and-verify

**Files:**
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/services/applyAndVerifyService.ts`
- Test: `tests/server/mcpToolJobQueue.test.ts`
- Test: `tests/server/applyAndVerifyService.test.ts`

**Interfaces:**
- Produces scheduler runtime callback `transitionAccess('verify')` valid only for an active `write` job.
- `applyAndVerifyAsync(..., setCancelFn, transitionAccess?)` invokes the transition after successful edit/plan/diff and before launching verification.

- [ ] Add a controlled-runner scheduler test where a write job downgrades to verify: an older/newly queued read starts after downgrade, while a queued writer remains blocked until the verify job finishes.
- [ ] Add/adjust apply-and-verify coverage that records the transition callback and verifies it fires after mutation/diff preparation but before verification process execution.
- [ ] Run both targeted test files and confirm the new tests fail.
- [ ] Implement `transitionJobAccess` to atomically update active resource accounting from `write` to `verify`, reject unsafe transitions, and immediately process newly compatible queued work without allowing another writer through.
- [ ] Wire the callback through the async runner and call it from `applyAndVerifyAsync` at the verification phase boundary.
- [ ] Re-run both targeted test files and commit this slice.

### Task 4: Multi-chat benchmark and observability evidence

**Files:**
- Modify: `scripts/benchmark-verification.ts`
- Optionally modify: `src/server/services/mcpToolMonitor.ts` only if scheduler metrics need explicit propagation.

**Interfaces:**
- Benchmark report adds `multiChat` with verify wall/run time and read job wait/wall metrics.

- [ ] Add a benchmark fixture with a long safe verification command and several same-repo read/search jobs enqueued while verification is running.
- [ ] Assert/report that reads complete while verification remains active and their queue wait is decoupled from verification duration.
- [ ] Run `npm run benchmark:verification` and capture the resulting metrics.
- [ ] Run targeted tests plus `npm run typecheck`.
- [ ] Run `npm run verify` after targeted checks pass.
- [ ] Commit benchmark/telemetry changes.

### Task 5: Review and close DVF-0354

**Files:**
- Review all changed scheduler, command, test, benchmark, and spec files.

- [ ] Inspect the final diff for accidental concurrency weakening, stale compatibility assumptions, and unrelated edits.
- [ ] Confirm working tree is clean after commits.
- [ ] Attach verification evidence to DVF-0354, complete its checklist, move it through review, and mark it done.
