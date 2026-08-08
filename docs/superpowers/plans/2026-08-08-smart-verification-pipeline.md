# Smart Verification Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce DevFlow agent verification latency by selecting the smallest safe checks, deduplicating equivalent work, reusing valid evidence, sharing concurrent executions, staging safe parallel work, and optimizing FULL verification without reducing correctness coverage.

**Architecture:** Resolve each requested verification command into a side-effect-free semantic descriptor before planning. The planner selects FAST/SAFE/FULL lanes and staged steps from those descriptors; the command runner owns conservative evidence fingerprints/cache reuse; the MCP queue owns cross-caller single-flight; `applyAndVerifyAsync` executes stages with bounded concurrency and fail-fast behavior; the repository FULL runner uses explicit safe groups while retaining every check.

**Tech Stack:** TypeScript 5.8, Node.js, `node:test`, tsx, npm package scripts, SQLite-backed DevFlow runtime.

## Global Constraints

- Preserve command allowlisting, cwd/path safety, timeout/output caps, cancellation behavior, structured errors, and final review verification requirements.
- Never weaken assertions or remove verification coverage for benchmark gains.
- FAST must not treat a package script named `test` as lightweight when it resolves to the FULL verify runner.
- Equivalent package scripts such as current `typecheck` and `lint` (`tsc --noEmit`) must be semantically deduplicated.
- Cache/evidence reuse must invalidate on repository/config/runtime identity changes and support `forceFresh`.
- Final FULL verification remains mandatory for the parent review gate.
- Baseline on 2026-08-08: cold `typecheck` 7,336ms; cold `lint` 7,391ms; FULL verify ran 70,471ms before failing at pre-existing `scripts/verify-orchestration.ts:169` (`triggerResult.triggered` was false).

---

### Task 1: Verification command semantics and FAST/SAFE/FULL planner (DVF-0344)

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Modify: `src/server/services/verificationPlannerService.ts`
- Test: `tests/server/projectCommandService.test.ts`
- Test: `tests/server/verificationPlannerService.test.ts`

**Interfaces:**
- Produces `describeProjectCommand(state, args): ProjectCommandDescriptor` with `command`, `semanticKey`, `scope`, `cost`, `resourceKey`, and resolved execution metadata.
- `planVerification` accepts resolved descriptors in addition to legacy command labels and emits `lane: 'fast' | 'safe' | 'full'` plus staged steps.

- [ ] **Step 1: Write RED planner tests for semantic dedup and FULL exclusion**

```ts
const plan = planVerification({
  changedFiles: ['src/components/Toolbar.tsx'],
  resolvedCommands: [
    { command: 'typecheck', semanticKey: 'tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
    { command: 'lint', semanticKey: 'tsc', scope: 'broad', cost: 'medium', resourceKey: 'typescript' },
    { command: 'test', semanticKey: 'full-verify', scope: 'full', cost: 'high', resourceKey: 'repo' },
  ],
});
assert.deepEqual(plan.commands, ['typecheck']);
assert.equal(plan.lane, 'fast');
assert.equal(plan.steps.some((step) => step.command === 'test'), false);
```

- [ ] **Step 2: Run planner tests and confirm RED**

Run: `npx tsx --test tests/server/verificationPlannerService.test.ts`
Expected: FAIL because `resolvedCommands`, semantic dedup, `full` lane, and stage metadata do not exist yet.

- [ ] **Step 3: Write RED command descriptor tests**

```ts
const typecheck = describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
const lint = describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'lint' });
const testCommand = describeProjectCommand(stateFor(root), { projectId: 'project-command', command: 'test' });
assert.equal(typecheck.semanticKey, lint.semanticKey);
assert.equal(testCommand.scope, 'full');
```

- [ ] **Step 4: Run command tests and confirm RED**

Run: `npx tsx --test tests/server/projectCommandService.test.ts`
Expected: FAIL because `describeProjectCommand` is not exported.

- [ ] **Step 5: Implement descriptor and planner minimally**

```ts
export type ProjectCommandDescriptor = {
  command: string;
  semanticKey: string;
  scope: 'targeted' | 'broad' | 'full';
  cost: 'low' | 'medium' | 'high';
  resourceKey: string;
};
```

For package scripts, semantic identity hashes normalized script content + cwd/source rather than the package-script label, so identical `typecheck`/`lint` scripts collapse. Treat a command as FULL when it is `verify` or its normalized package script equals the repository `verify` script. FAST excludes FULL descriptors and selects the lowest-cost deduplicated non-FULL evidence; FULL lane prefers one FULL descriptor because it subsumes broad checks.

- [ ] **Step 6: Run focused tests GREEN**

Run both focused test files; expected PASS.

- [ ] **Step 7: Commit slice**

Commit message: `perf: add verification command semantics`

---

### Task 2: Verification evidence reuse and repo-command single-flight (DVF-0345)

**Files:**
- Modify: `src/server/services/projectCommandService.ts`
- Modify: `src/server/services/commandResultCacheService.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Test: `tests/server/projectCommandService.test.ts`
- Test: `tests/server/mcpToolJobQueue.test.ts`

**Interfaces:**
- `getProjectCommandExecutionIdentity(state, args)` returns a deterministic execution key derived from repo revision + semantic command + cwd/config/runtime inputs.
- `forceFresh: true` skips cache lookup but may refresh successful evidence after execution.
- Repo-command jobs use execution identity for single-flight by default unless explicitly disabled.

- [ ] **Step 1: Add RED cache tests**

```ts
const first = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
const second = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck' });
assert.equal(second.cache?.hit, true);
assert.equal(second.processSpawns, 0);
const fresh = runProjectCommand(stateFor(root), { projectId: 'project-command', command: 'typecheck', forceFresh: true });
assert.equal(fresh.cache?.hit, false);
assert.equal(fresh.processSpawns, 1);
```

- [ ] **Step 2: Run command tests RED**

Expected: default second call is not cached and `forceFresh` is unsupported.

- [ ] **Step 3: Implement conservative automatic reuse**

Automatic default reuse applies to deterministic static verification (`typecheck`/`lint` and equivalent descriptors). `test`/`verify` continue to require workflow opt-in unless the caller already sets `cacheResult: true`. Cache key uses repo revision + semantic identity + cwd + timeout/output + platform/arch/node + `NODE_ENV`, `CI`, and `NODE_OPTIONS`.

- [ ] **Step 4: Add RED repo-command single-flight test**

Enqueue two equivalent repo-command jobs simultaneously without `singleFlight: true`; assert the controlled runner starts once and both jobs receive the leader result.

- [ ] **Step 5: Run queue test RED, then implement normalized default single-flight**

Use `getProjectCommandExecutionIdentity` instead of raw argument hashing for repo-command jobs. Preserve follower cancellation: cancelling a follower must not cancel the leader; cancelling the leader follows existing leader/follower finalization rules.

- [ ] **Step 6: Run focused cache/queue tests GREEN**

Expected PASS.

- [ ] **Step 7: Commit slice**

Commit message: `perf: reuse verification evidence and single-flight commands`

---

### Task 3: Staged resource-aware verification executor (DVF-0346)

**Files:**
- Modify: `src/server/services/verificationPlannerService.ts`
- Modify: `src/server/services/applyAndVerifyService.ts`
- Test: `tests/server/verificationPlannerService.test.ts`
- Test: `tests/server/applyAndVerifyService.test.ts`

**Interfaces:**
- Planner steps expose `stage`, `resourceKey`, and optional `parallelGroup`.
- Async executor returns `verificationPerformance` with wall time, summed execution time, process spawns, and cache hits.

- [ ] **Step 1: Add RED fail-fast stage test**

Create a fast prerequisite fixture that fails and a later fixture that increments a file counter. Execute `applyAndVerifyAsync`; assert failure and counter file absence.

- [ ] **Step 2: Add RED bounded-parallel test**

Use two resource-isolated ~800ms fixture checks in the same planner stage and assert wall time is materially below summed command duration.

- [ ] **Step 3: Run executor tests RED**

Expected failures because current implementation runs all isolated commands before serial commands and has no explicit stages/summary metrics.

- [ ] **Step 4: Implement staged executor**

Group steps by ascending `stage`. Within each stage, run only resource-safe parallel members concurrently (bounded to 4); serialize conflicting members. After each stage, return immediately on required failure before launching the next stage. Pass `forceFresh` through to the command runner and aggregate normalized performance metrics.

- [ ] **Step 5: Run executor/planner tests GREEN**

Expected PASS with deterministic timing margin.

- [ ] **Step 6: Commit slice**

Commit message: `perf: stage and parallelize verification execution`

---

### Task 4: FULL verify runner optimization and benchmark evidence (DVF-0347)

**Files:**
- Modify: `scripts/verify.ts`
- Create: `scripts/benchmark-verification.ts`
- Modify: `package.json`
- Test/Create: `tests/server/verifyRunnerPlan.test.ts`

**Interfaces:**
- `scripts/verify.ts` exposes/uses an explicit step inventory with `stage` and `parallelSafe` metadata.
- Benchmark script emits JSON/console summary for cold, warm, duplicate, targeted, and FULL scenarios.

- [ ] **Step 1: Add RED runner inventory test**

The test imports a pure step-plan export and asserts every current verification label is present, `lint` is the first static gate, and integration/resource-sensitive steps are not marked parallel-safe.

- [ ] **Step 2: Run runner test RED**

Expected: FAIL because the step inventory is currently an internal serial array.

- [ ] **Step 3: Implement explicit staged FULL runner**

Replace the single `spawnSync` loop with async `spawn` execution helpers. Keep `lint` as an early prerequisite. Parallelize only audited test-file checks that isolate their temp DB/process state, maximum concurrency 4. Keep restart, contract, orchestration, launcher, doctor, and other shared-resource integration scripts serialized. On any stage failure, stop before later stages and emit the same capped stdout/stderr diagnostics.

- [ ] **Step 4: Add benchmark harness**

Benchmark script records wall time, execution time, cache hit state, and process-spawn counts for command-runner scenarios. It prints machine-readable JSON and a compact human summary; it does not mutate coverage or command semantics.

- [ ] **Step 5: Run after benchmarks and compare to baseline**

Targets: unchanged deterministic verification <200ms and 0 new verification process spawns; duplicate compiler work removed; FAST UI/source plan contains no FULL `test`; FULL wall time materially below the >=70.47s incomplete baseline while preserving step inventory.

- [ ] **Step 6: Run final FULL verify**

If the pre-existing orchestration assertion still fails unchanged, reproduce it independently, open a parent bug thread with baseline evidence, and fix only if the root cause is inside the current branch/workflow contract and can be covered by a regression test. Final parent review requires a passing FULL verify.

- [ ] **Step 7: Commit slice**

Commit message: `perf: optimize full verification runner`

---

### Task 5: Integration, evidence, and review gate (DVF-0343)

**Files:**
- Update task/checklist evidence only; no new production behavior unless a regression is found.

- [ ] **Step 1: Run focused regression suite**

Run planner, command, queue, executor, runner-plan, and workflow health tests.

- [ ] **Step 2: Run benchmark matrix with `forceFresh` where required**

Record cold/warm/concurrent/targeted/FULL measurements and compare to the baseline values in this document.

- [ ] **Step 3: Run final repository FULL verify**

Expected PASS, with no removed verification labels.

- [ ] **Step 4: Inspect git diff and clean tree, then push active branch**

Use DevFlow dry-run commit/push guards; no force push or history rewriting.

- [ ] **Step 5: Mark all child and parent checklist items complete and submit for review**

Attach structured verification evidence with `sync_task_with_git` / `submit_task_for_review`.
