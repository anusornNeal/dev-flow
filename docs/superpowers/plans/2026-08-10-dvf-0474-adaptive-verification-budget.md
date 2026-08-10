# DVF-0474 Adaptive Verification Resource Budget Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace identical verification slots with weighted, evidence-backed resource admission while preserving DVF-0456 permit safety and a conservative fixed-capacity fallback.

**Architecture:** Keep the existing verification permit map as the single source of ownership/release truth. Extend each permit with a predicted resource demand from DVF-0473, evaluate new permits against configurable CPU/memory/process ceilings plus live machine pressure, and learn bounded pairwise interference from predicted-vs-actual duration while jobs overlap. Unknown/low-confidence profiles or unavailable live signals continue through the old fixed-capacity path.

**Tech Stack:** TypeScript, Node.js `os`, existing DevFlow scheduler/job queue, DVF-0473 resource profile service, `node:test`.

## Global Constraints

- Do not create a second scheduler or bypass DVF-0456 permits/shared-resource guards.
- Adaptive admission optimizes wall-clock throughput and interactive responsiveness, not utilization percentage.
- Target CPU/memory ranges are configurable operating targets; hard ceilings remain stricter safety bounds.
- Never kill healthy running verification solely because live pressure rises; pause new admissions instead.
- Unknown/low-confidence profile or missing live signals must preserve fixed-capacity behavior.
- Reads/writes and correctness locks remain independent of verification weighted budget.
- Permit release is authoritative: no separate counter may survive release/cancel/failure/restart.
- No push.

---

### Task 1: RED contracts for weighted permits and fallback

**Files:**
- Modify: `tests/server/mcpToolJobScheduler.test.ts`

- [ ] Add deterministic high-capacity profile test: one moderate-heavy + multiple light demands fit and exceed fixed-slot baseline safely.
- [ ] Add constrained profile test: heavy + heavy is rejected by CPU/memory budget.
- [ ] Add unknown/low-confidence and missing-live-signal tests proving fixed-capacity fallback remains authoritative.
- [ ] Add memory/shared-resource/live-pressure blockers and interactive-read responsiveness assertions.
- [ ] Run scheduler tests RED.

### Task 2: Weighted permit admission

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Modify: `src/server/services/mcpToolJobScheduler.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/services/applyAndVerifyService.ts`

- [ ] Export one project-command resource prediction helper so scheduler/composite children use the exact DVF-0473 profile identity.
- [ ] Extend scheduler profile/queue entry/permit requests and permits with normalized weighted demand.
- [ ] Add configurable target CPU, hard CPU, target memory pressure, hard memory pressure and adaptive process ceiling.
- [ ] Admit adaptively only when request + active permit demands have sufficient confidence and live CPU/memory signals are usable; otherwise use fixed capacity.
- [ ] Keep shared-resource conflict checks ahead of weighted admission.
- [ ] Feed child verification-step demand through existing write→verify execution lease.

### Task 3: Live feedback and interference learning

**Files:**
- Modify: `src/server/services/mcpToolJobScheduler.ts`
- Modify: `src/server/services/mcpToolJobService.ts`

- [ ] Use rolling system snapshots for live CPU/memory pressure and add a deterministic test override.
- [ ] Pause new adaptive permits at target/hard live pressure without cancelling existing permits.
- [ ] Track overlapping profile pairs on permit acquisition; on observed completion, record bounded slowdown samples.
- [ ] Serialize profile pairs with repeated material slowdown even when nominal resource budget fits.
- [ ] Surface adaptive/fallback mode, weighted active demand, pressure and interference telemetry in capacity snapshot.

### Task 4: Release/recovery and benchmark verification

**Files:**
- Modify: `tests/server/mcpToolJobScheduler.test.ts`
- Modify if needed: `tests/server/mcpToolJobQueue.test.ts`
- Modify if needed: `tests/server/mcpToolMonitor.test.ts`

- [ ] Prove release/reset removes weighted demand and allows a waiting permit.
- [ ] Prove fixed baseline admits at most N unknown jobs while adaptive safe mix admits more and yields lower synthetic makespan; interactive read remains runnable.
- [ ] Run focused scheduler + queue + profile/command tests and typecheck once.
- [ ] Review diff, commit scoped changes, finalize into local `develop`, and continue board loop.
