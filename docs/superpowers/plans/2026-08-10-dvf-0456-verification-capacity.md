# DVF-0456 Verification Capacity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the configured verification-process capacity a hard upper bound for normal verify jobs, write→verify transitions, and parallel `apply_and_verify` child commands without blocking unrelated reads.

**Architecture:** Keep repository access locks and actual verification-process permits separate. Normal verify jobs continue to consume one process permit when admitted. A composite write job atomically waits for and reserves its first verification permit before downgrading to verify access, then every child command runs through the same global process/shared-resource permit governor. The composite parent itself holds verify access but does not double-count a process permit.

**Tech Stack:** TypeScript, Node.js test runner, DevFlow durable job scheduler.

## Global Constraints

- TDD: tests must fail for the missing behavior before production changes.
- Do not redesign immutable candidate creation or command configuration.
- Do not restart DevFlow in this card.
- Preserve read responsiveness and write exclusivity.
- No push; integrate committed work into local `develop` only after focused verification.

---

### Task 1: Reproduce write→verify capacity overflow

**Files:**
- Modify: `tests/server/mcpToolJobScheduler.test.ts`
- Modify: `tests/server/mcpToolJobQueue.test.ts`

**Interfaces:**
- Consumes: existing scheduler capacity snapshots and job transition callback.
- Produces: regression proving a write→verify job does not start verification while capacity/shared resources are saturated.

- [ ] Add a scheduler regression that fills capacity, attempts transition reservation, and asserts active verification never exceeds capacity.
- [ ] Add a queue regression with capacity 1 where a running verify job blocks a write job's transition until the verify slot releases while unrelated reads remain runnable.
- [ ] Run focused tests and verify the new assertions fail for the current synchronous transition behavior.

### Task 2: Reproduce composite child over-concurrency

**Files:**
- Modify: `tests/server/applyAndVerifyService.test.ts`

**Interfaces:**
- Consumes: `applyAndVerifyAsync` verification transition callback.
- Produces: deterministic observed maximum child-process concurrency assertion.

- [ ] Add a test governor that permits only N child verification executions across concurrent composite calls.
- [ ] Assert the existing fixed batch-of-four path exceeds the configured budget before the fix.
- [ ] Cover failure/cancellation release so a later child can acquire the freed permit.

### Task 3: Implement shared verification-process permits

**Files:**
- Modify: `src/server/services/mcpToolJobScheduler.ts`
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/services/applyAndVerifyService.ts`

**Interfaces:**
- Consumes: scheduler `globalVerifyCapacity`, verification classes, and shared-resource metadata from verification plan steps.
- Produces: bounded permit acquire/release and async write→verify transition lease used by child commands.

- [ ] Separate verify-access accounting from process-permit accounting so a composite parent can hold verify access without double-counting a child process.
- [ ] Add atomic try-acquire/release helpers for verification process permits with shared-resource capacity checks and real capacity diagnostics.
- [ ] Make `transitionJobAccess` wait cooperatively for the first process permit, honor cancellation/lease loss, then atomically downgrade write→verify.
- [ ] Return a verification execution lease to `applyAndVerifyAsync`; run every child command through it and release permits in `finally` on success/failure/timeout/cancel.
- [ ] Keep direct `applyAndVerifyAsync` calls backward-compatible with an unlimited local no-op governor when no scheduler callback is supplied.

### Task 4: Verify, commit, integrate

**Files:**
- Test: `tests/server/mcpToolJobScheduler.test.ts`
- Test: `tests/server/mcpToolJobQueue.test.ts`
- Test: `tests/server/applyAndVerifyService.test.ts`

- [ ] Run all three focused suites and `typecheck`.
- [ ] Record the unrelated pre-existing full-verify MCP transport benchmark failure separately; do not fold it into this card.
- [ ] Commit only DVF-0456 scope, integrate the managed workspace into latest local `develop`, re-run focused verification, sync checklist/evidence, and close DVF-0456.
