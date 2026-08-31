# DVF-0864 Verification Cost Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring planner-required FULL verification under the existing 270s headroom without increasing timeout, dropping coverage, or paying for speculative tuning loops.

**Architecture:** Optimize only measured critical-path work. Every candidate must have a baseline, projected saving, semantic safety argument, success threshold, and rollback condition before implementation. Rejected experiments are rolled back before the next candidate; FULL runs are reserved for candidates whose combined model leaves meaningful headroom.

**Tech Stack:** Node.js, TypeScript, node:test, Git CLI, DevFlow managed verification runner.

**Spec:** DevFlow task `DVF-0864`.

## Global Constraints

- Work only through the managed DVF-0864 workspace and integrate only into local `overhaul-devflow`; no push.
- Preserve complete FULL verification semantics and truthful failure reporting.
- Do not increase verification timeout/headroom as the fix.
- Do not weaken planner safety, canonical verification identity, or Git/workspace isolation.
- Do not run another FULL verification until the projected total is <=260-265s, leaving non-trivial contention headroom.

---

### Task 1: Close the disproven root-fixture bootstrap experiment

**Files:** No retained code change.

- [x] Cheap RED contract proved per-fixture root Git bootstrap still existed.
- [x] Seed-repository plus `fs.cpSync` experiment preserved 27/27 finalization semantics.
- [x] Baseline ~146.5s versus experiment ~146.2s: <1% improvement, below the >=30s or >=25% gate.
- [x] Experiment fully rolled back. Do not propagate this pattern to session/workspace suites.

---

### Task 2: Close the disproven finalization sharding experiment

**Files:** No retained experiment change in `tests/server/taskWorkspaceFinalizationService.test.ts`; stable five-group runner plan remains retained.

- [x] Cheap runner RED failed for the intended new shard labels and top-level recovery tests.
- [x] Refactor/shard implementation made runner contract GREEN 12/12 and finalization GREEN 34/34 in 144.92s.
- [x] Replaying measured durations through the exact weighted scheduler reproduced the current Stage 2 parallel segment at ~267.019s.
- [x] Even assuming zero extra process overhead, proposed sharding lowered the model only to ~261.7s: ~5.3s saved, below the >=30s gate.
- [x] Experiment fully rolled back to exact pre-experiment revisions. Cheap runner sanity after rollback: 11/11 GREEN in ~0.8s. No FULL was spent on this candidate.

---

### Task 3: Reduce only serial MCP benchmark async waiting

**Files:**
- Modify: `scripts/benchmark-mcp-transport.ts`
- Test: `tests/server/mcpTransportBenchmark.test.ts`

**Interfaces:**
- Consumes: `ASYNC_BENCHMARK_DURATIONS_MS = [3_000, 10_000]`, independent benchmark job IDs, and existing streamable/SSE async UX gates.
- Produces: the same ordered async workload result arrays and gate inputs while overlapping only independent 3s/10s async waits within each protocol. Sync latency samples remain serial and unchanged.

**Cost model:**
- Latest FULL serial benchmark gate: 34.966s; earlier focused benchmark command: ~35.6s.
- Streamable HTTP and legacy SSE each pay 3s + 10s sequential async waits, a 13s floor per protocol.
- Overlapping only those two waits changes each protocol floor to ~10s, projecting ~6s direct FULL wall-time saving because the benchmark gate is serial.
- This is insufficient alone but is low-risk and directly additive.

**Explicit exclusions:**
- Do not run streamable HTTP and legacy SSE sync latency protocols concurrently; that changes benchmark load.
- Do not alter durations, completion window, sample counts, regression thresholds, fallback thresholds, timeout/headroom, or assertions merely to gain speed.
- Do not change scheduler weights during this experiment.

- [x] **Step 1: Write a deterministic RED contract**

Add a unit-level contract for an async workload helper using short fake delays. The test must prove requested-order results and overlapping elapsed time without paying real 3s/10s delays, and must fail before implementation.

- [x] **Step 2: Implement only intra-protocol async overlap**

Use `Promise.all` over the configured async durations after warm sync sampling. Preserve source-order results plus existing `completedWithoutFollowUp` and `completionMode` semantics.

- [x] **Step 3: Run cheap contract then one focused benchmark**

Deterministic RED measured 223ms for fake 40ms+160ms sequential waits, then GREEN passed after `Promise.all`. The focused benchmark passed in 28.915s versus ~35.6s baseline, saving ~6.7s and clearing the >=4s gate while preserving all existing benchmark UX/fallback assertions.

- [x] **Step 4: Recompute FULL model without running FULL**

The measured ~6.7s benchmark delta lowers the latest through-Stage-2 runner projection from ~323.733s to ~317.0s. This remains far above the <=260-265s admission target, so no FULL run is authorized yet.

---

### Task 4: Investigate remaining critical-path work only after Task 3

**Files:** Read-only first; no code change until a new numeric gate is written.

**Evidence:**
- Latest FULL Stage 2: 301.986s; total 323.733s.
- CPU ~45%, process tree up to ~49: process/Git/filesystem contention dominates rather than CPU saturation.
- Claim isolated ~75s versus FULL 106.85s; project command ~33s versus 47.95s; MCP job queue ~20s versus 28.94s.
- Lowering finalization weight alone is unsafe: fixed-duration model gives ~286.8s at weight 2 and ~270.2s at weight 1, with no contention headroom.

- [x] **Step 1: Inspect claim/commit/worktree repeated operations read-only**

Root Git bootstrap was rejected statically: finalization had more root fixtures than session/workspace yet seed-copy saved <0.3s. Workspace integration isolated at 32.55s versus 43.50s in FULL, a 10.95s contention delta, below the 12s adaptive threshold; sessionWorkspace profiling was therefore skipped. The next probe targets `taskGitWorkflowService`, which overlaps the long-running claim and has FULL duration 42.21s.

- [x] **Step 2: Write a new candidate-specific cost gate before mutation**

Adaptive contention gate: run `taskGitWorkflowService` isolated once. Continue to profile `taskCommitPlan` only if taskGit isolated <=30s, i.e. >=12s faster than its 42.21s FULL duration. If it misses, close resource-gating as insufficient and do not change weights. If it passes, require the combined measured/modelled candidate to project <=260-265s before any scheduler mutation or FULL run.

- [x] **Step 3: Measure claim-path contention and retire stale Stage 3 orchestration wiring**

`taskGitWorkflowService` isolated passed in 24.83s versus 42.21s in FULL (17.38s recovery). `taskCommitPlan` isolated passed in 48.07s versus 68.69s in FULL (20.62s recovery). Together with task claim (~75s isolated versus 106.85s FULL), the measured contention pool has ~69.9s gross recovery potential, but naive serialization is not sufficient because it sacrifices overlap. Separately, DVF-0833 intentionally deleted `scripts/verify-orchestration.ts` and the `test:orchestration` package script while `verifyPlan.ts` still referenced it. Replace that stale Stage 3 command with current agent-neutral handoff/status tests and keep a regression that every `npm run` verification step resolves to an existing package script. Modern orchestration replacement passed 19/19 in 3.43s.

- [x] **Step 4: Parallelize only isolated Stage 1 runtime-contract fixtures**

Latest FULL Stage 1 is 13.319s: restart route 3.671s, restart contract 1.528s, restart state 1.635s, DevFlow contract 4.635s, tool profiles 1.848s. Static audit proves process isolation: each mutable fixture uses a unique temp root/DB, HTTP servers bind port 0, and the pure contract/profile checks do not mutate a shared supervisor. Mark all five Stage 1 steps parallel-safe. Expected stage wall is bounded by the slowest measured step (~4.64s), a direct ~8.68s saving. Roll back if focused runner contracts fail or any fixture is found to depend on shared runtime state. Focused runner contract is GREEN after the change.

- [x] **Step 4b: Reject unsafe gateway multi-file parallelization**

Measured the four existing gateway files individually at ~1.94s, ~2.02s, ~1.47s, and ~3.46s. A TDD candidate changed the sequential package script to one `tsx --test` multi-file invocation, but the real combined run failed with `SQLITE_BUSY` and duplicate migration ids because several files intentionally rely on the same default DB path. The package script and its candidate-specific regression were rolled back immediately. Do not parallelize this gateway group without first isolating its DB ownership; that fixture refactor is outside the current ROI budget.

- [ ] **Step 4c: Overlap only isolated async transport phases across protocols**

Current optimized transport benchmark is 28.915s. Sync transport measurements must remain sequential and unchanged. The remaining async floor is roughly 10s for streamable HTTP plus 10s for legacy SSE because the two protocol phases still run one after another. New candidate: finish all sync measurements sequentially first, then run only the async workload phases concurrently on two independent benchmark-server fixtures. Each fixture must use its own server/job map/client connection, preserve per-protocol `[3000,10000]` requested-order results, and keep the existing async/fallback gates unchanged. Deterministic helper RED/GREEN must prove cross-protocol overlap before the real benchmark. ROI gate: real focused benchmark must remain fully GREEN and improve by >=7s from 28.915s (target <=21.9s); otherwise rollback.

- [ ] **Step 5: Implement resource-aware contention fences only if the combined model clears admission**

Use named exclusive resources rather than coarse global weights. Candidate A: `task claim service`, `task git workflow service`, and `task commit plan` share one Git-authority resource. Candidate B: `project command service` and `mcp tool job queue` share one command-runtime resource. Fixed-schedule simulation using measured isolated durations projects the Stage 2 parallel segment from ~267.0s to ~227.2s; with the measured 28.915s benchmark this is ~256.1s for Stage 2. Combined with parallel Stage 1 and Stage 0 this remains near ~269s before Stage 3, so no FULL is authorized until one additional measured optimization supplies real headroom.

---

### Task 5: Final verification and closure

- [ ] Re-run verify-runner regression and typecheck on the final candidate.
- [ ] Re-inspect planner; conservative SAFE fallback must still select full `test` for the runner source changes.
- [ ] Start a fresh verification recovery batch because the prior authoritative batch failed; do not reuse failed authority.
- [ ] Run the planner-required full `test` once with the existing 270s internal headroom. Require exit 0 and complete group coverage.
- [ ] Commit task-owned files only, integrate locally into `overhaul-devflow`, never push, and resume normal finalization.
- [ ] Attach DVF-0860 proof telemetry: planner fallback/full selection, candidate execution/reuse truth, prior failed FULL evidence, final FULL wall time, post-integration behavior, and final-verification-to-DONE wall time.

## Self-review

- Spec coverage: profiling, diagnostics, bounded scheduling, coverage preservation, setup-cost investigation, final proof, and no-timeout-inflation requirements are represented.
- Placeholder scan: no deferred implementation placeholders; future mutation is explicitly gated by measured evidence.
- Type/interface consistency: Task 3 changes only benchmark-internal async scheduling and retains the current result schema/gates.
