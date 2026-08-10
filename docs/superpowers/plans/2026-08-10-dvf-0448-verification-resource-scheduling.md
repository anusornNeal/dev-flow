# DVF-0448 Verification Resource Scheduling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Model shared verification resources and distinguish fast versus heavy verification so scheduling can overlap independent work while bounding FULL/heavy work from measured evidence.

**Architecture:** Extend side-effect-free project-command descriptors with additive `verificationClass` and `sharedResources` metadata, then propagate that metadata through verification plans. Benchmark the existing scheduler before changing policy. After DVF-0447 lands, consume the metadata in the scheduler with separate fast/heavy accounting and shared-resource conflict checks while keeping heavy capacity bounded and fairness aging intact.

**Tech Stack:** TypeScript 5.8, Node.js, `node:test`, tsx, SQLite-backed DevFlow runtime.

## Global Constraints

- Do not weaken verification coverage or command safety.
- Do not increase global verification concurrency solely to reduce queue depth.
- Preserve DVF-0443/DVF-0444 non-blocking admission, DVF-0445 immutable candidates, DVF-0446 supersession/backpressure, and DVF-0447 lease/fencing semantics.
- No automatic push.
- Do not edit DVF-0447-owned lease/recovery code until that card is integrated into `develop`.

---

### Task 1: Verification resource metadata foundation

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Modify: `src/server/services/verificationPlannerService.ts`
- Modify: `tests/server/projectCommandService.test.ts`
- Modify: `tests/server/verificationPlannerService.test.ts`

- [x] Classify verification descriptors as `fast` or `heavy` without changing command selection.
- [x] Expose minimal shared-resource keys from command descriptors.
- [x] Propagate class/resource metadata through verification plans.
- [x] Keep command safety and existing FAST/SAFE/FULL coverage unchanged.

### Task 2: Measure current scheduling before policy changes

**Files:**
- Modify: `scripts/benchmark-verification.ts`

- [x] Report targeted/FULL mix wall time, capacity wait, execution time, and max process concurrency.
- [x] Benchmark the existing capacity-2 policy before accepting a scheduler policy change.
- [x] Keep global verification capacity at 2; do not raise it from queue-depth pressure alone.

### Task 3: Resource-aware fast/heavy scheduling after DVF-0447

**Files:**
- Modify: `src/server/services/mcpToolJobScheduler.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `tests/server/mcpToolJobScheduler.test.ts`
- Modify: `tests/server/mcpToolJobQueue.test.ts`

- [x] Refresh the worktree onto the DVF-0447-integrated base before editing shared scheduler/job files.
- [x] Add RED tests for fast priority, heavy bounded capacity, starvation-safe aging, same shared-resource conflict, and independent-resource overlap.
- [x] Implement the smallest measured policy: metadata-driven priority/resource accounting with global verify capacity unchanged at 2.
- [x] Verify that a newer fast job wins a spare slot over already queued heavy work, while 30-second aging still prevents heavy starvation.
- [x] Reject reserved-fast/grace policies that materially regress FULL throughput.
- [x] Run focused scheduler/queue/planner/project-command tests and benchmark repeated control/candidate policies.
- [x] Run typecheck and fresh FULL repository verification.
- [ ] Commit, integrate into `develop`, attach evidence, and close DVF-0448.

## Benchmark Evidence

Representative resource mix uses two heavy/FULL jobs (`1.8s` synthetic body) plus one interactive fast job (`0.25s` synthetic body). Global verify capacity remains 2 in every run, and measured max verification process concurrency never exceeds 2.

### Control/final policy: no reserved fast slot

Three control runs with capacity 2 and no reservation/grace:

- Total mix wall: `3132ms`, `3143ms`, `3269ms`.
- Fast wall: `2380ms`, `2380ms`, `2460ms`.
- Fast capacity wait: `1624ms`, `1608ms`, `1541ms`.
- Heavy p95 wall: `2692ms`, `2685ms`, `2798ms`.
- Second heavy job was already `running` before the later fast arrival in all three runs.

A final post-implementation run reproduced the same behavior: total `3135ms`, fast wall `2396ms`, fast capacity wait `1626ms`, heavy p95 `2684ms`, max concurrency `2`.

This is intentional: the scheduler prioritizes fast work over **queued** heavy work, but does not preempt heavy work that has already consumed both bounded verification slots.

### Rejected candidate: 125ms heavy burst grace / implicit fast reservation

Three candidate runs:

- Total mix wall: `3899ms`, `3808ms`, `3765ms`.
- Fast wall: `781ms`, `754ms`, `738ms` with zero capacity wait.
- Heavy p95 wall: `3487ms`, `3494ms`, `3434ms`.
- Second heavy job remained queued so the fast job could take the spare slot.

The candidate improved interactive fast latency substantially, but total mix wall regressed by roughly 19-24% and heavy/FULL p95 by roughly 23-30%. That violates the card's requirement to improve interactive latency without materially regressing FULL throughput/stability, so the reservation/grace policy was removed.

An earlier hard-serialization experiment for coarse `repo` resources showed the same trade-off and was also rejected. Final policy therefore keeps coarse `repo` capacity at the existing bounded pool while allowing exclusive known resource classes to serialize independently.

## Final Policy

- Global verification capacity remains `2`.
- Queue entries carry descriptor-derived `verificationClass` and project-scoped `sharedResources`.
- `fast` verification has higher queue priority than `heavy` verification.
- Existing 30-second priority aging remains in place so heavy/FULL work cannot starve.
- Coarse `repo` verification consumes the bounded capacity-2 pool instead of becoming a global lock.
- Specific shared-resource classes consume their own capacity-1 pool regardless of fast/heavy class; coarse `repo` remains capacity 2, and unrelated resource classes can overlap.
- No preemption, no reserved fast slot, and no concurrency increase were accepted because benchmark evidence did not justify them.

## Verification Evidence

- Focused scheduler + queue + project-command + planner suite: `68/68` passed.
- Typecheck: passed (`exit 0`).
- Fresh FULL `verify`: passed (`exit 0`, ~97.4s), including lint, MCP tool job queue/recovery/scheduler policy, workspace integration, persistence, and gateway safety.
