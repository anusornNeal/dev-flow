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



### Task 2: Measure current scheduling before policy changes

**Files:**
- Modify: `scripts/benchmark-verification.ts`
- Test: nearest benchmark contract test if present.



### Task 3: Resource-aware fast/heavy scheduling after DVF-0447

**Files:**
- Modify: `src/server/services/mcpToolJobScheduler.ts`
- Modify: `src/server/services/mcpToolJobService.ts` only after DVF-0447 is integrated.
- Modify: `tests/server/mcpToolJobScheduler.test.ts`
- Modify: `tests/server/mcpToolJobQueue.test.ts`

- [ ] Refresh the worktree onto the DVF-0447-integrated base before editing shared scheduler/job files.
- [ ] Add RED tests for fast priority, heavy bounded capacity, starvation-safe aging, same shared-resource conflict, and independent-resource overlap.
- [ ] Implement the smallest measured policy that improves targeted latency without materially reducing FULL throughput.
- [ ] Run focused scheduler/queue/planner/project-command tests and benchmark at least three times.
- [ ] Run typecheck and fresh FULL repository verification.
- [ ] Commit, integrate into `develop`, attach evidence, close DVF-0448, then close parent DVF-0442 if DVF-0447 is also done.
