# Flexible Lifecycle Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the shared flexible-lifecycle model that later DVF-0705 consumers can use without stage-walking or verification-quality authority.

**Architecture:** Add a small pure `lifecycleGuardrailModel` for canonical hard blocker/debt/warning/reconciliation data. Refactor `lifecycleAuthorityService` to publish this model and derive commit safety without stage/verification gates. Keep the legacy ordered transition service unchanged and add a dedicated `executionLifecycleReconciliationService` that records one explicitly marked direct transition from observed reality without validating intermediate stages.

**Tech Stack:** TypeScript 5.8, Node test runner via `tsx --test`, SQLite-backed execution-session repository.

**Spec:** `docs/superpowers/specs/2026-08-21-flexible-lifecycle-foundation-design.md`

## Global Constraints

- Preserve ambiguous/foreign ownership and live-operation concurrency as hard safety.
- Verification quality is debt, never fabricated GREEN evidence.
- Keep historical lifecycle stage values and the existing ordered transition API readable/usable for compatibility during this slice.
- Direct reconciliation must emit exactly one marked transition and no synthetic intermediate stages.
- Do not modify commit/finalize/review/restart/public contract behavior in this child.
- No push.

---

### Task 1: Canonical guardrail result model

**Files:**
- Create: `src/server/services/lifecycleGuardrailModel.ts`
- Create: `tests/server/lifecycleGuardrailModel.test.ts`

**Interfaces:**
- Produces: `LifecycleGuardrailIssue`, `LifecycleReconciliationRecord`, `LifecycleGuardrailAssessment`, `createLifecycleGuardrailAssessment(...)`, `isLifecycleOperationAllowed(...)`.
- Consumes: no repository state; pure values only.

- [x] **Step 1: Write the failing test**

Test category separation/deduplication, debt-only non-blocking behavior, and operation-scoped hard safety.

- [x] **Step 2: Run the focused test and confirm RED**

Observed RED: `ERR_MODULE_NOT_FOUND` for `lifecycleGuardrailModel`, proving the new model was absent before implementation.

- [x] **Step 3: Implement the pure model**

Create exported issue/category/operation types and a builder that normalizes arrays and deduplicates by code per category. `isLifecycleOperationAllowed` checks only hard blockers applicable to the requested operation.

### Task 2: Stage-independent lifecycle authority

**Files:**
- Modify: `src/server/services/lifecycleAuthorityService.ts`
- Modify: `tests/server/lifecycleAuthorityService.test.ts`

**Interfaces:**
- Consumes: canonical guardrail model from Task 1.
- Produces: `snapshot.guardrails` and stage-independent `snapshot.commit.ready/reasonCodes`.

- [x] **Step 1: Change the authority regression test first**

The fixture now asserts that owned changes remain commit-safe while lifecycle is still `implementing` and verification is pending/failed, with those verification states preserved in `guardrails.debts`.

- [x] **Step 2: Implement minimal authority changes**

Verification batch/freshness state becomes debt. Existing hard identity/ownership ambiguity remains hard. Commit readiness no longer requires `stage === verifying` or authoritative verification; it still requires unique authority, no live conflicting durable operation, readable ownership state and task-owned changes.

- [x] **Step 3: Preserve compatibility fields**

Keep `hardBlockers`, `softDrift`, `info`, `verification`, and legacy classification output so Wave 2 can migrate incrementally.

### Task 3: Direct lifecycle reconciliation

**Files:**
- Create: `src/server/services/executionLifecycleReconciliationService.ts`
- Modify: `tests/server/executionSessionService.test.ts`

**Interfaces:**
- Produces: `ExecutionLifecycleReconciliationInput` and `reconcileExecutionLifecycleStage(id, input)`.
- Reuses: execution-session repository and checkpoint persistence.
- Preserves: `executionSessionService` ordered transition API unchanged.

- [x] **Step 1: Write reconciliation regression before production implementation**

Test direct `created -> committed`, idempotent replay, conflicting replay rejection, and retained strict behavior of the legacy ordered transition API.

- [x] **Step 2: Implement direct reconciliation**

Validate active session, concrete target, completed evidence, reason and evidence identity. Detect prior lifecycle observation by origin evidence. Persist exactly one `lifecycle-transition` record marked `directReconciliation: true` and `skippedStageValidation: true`, then refresh checkpoint/session state. Do not call or widen the legacy transition graph.

- [x] **Step 3: Keep legacy transition behavior unchanged**

`EXECUTION_LIFECYCLE_TRANSITIONS` and `recordExecutionLifecycleTransition` are untouched; direct reconciliation is an explicit separate service.

### Task 4: Final SAFE verification and commit

**Files:** all files above.

- [ ] **Step 1: Inspect git status/diff and freeze the candidate**

Confirm only DVF-0706-owned files changed and no other-session work is present.

- [ ] **Step 2: Run one final frozen-candidate verification batch**

Required checks on the same candidate:
- `test-focused` targeting `tests/server/lifecycleGuardrailModel.test.ts`, `tests/server/lifecycleAuthorityService.test.ts`, `tests/server/executionSessionService.test.ts`
- TypeScript typecheck

Expected: all focused tests pass and TypeScript emits no errors.

- [ ] **Step 3: If verification fails, repair then run only the same minimum recovery batch on the new candidate**

Do not loop broad verification.

- [ ] **Step 4: Commit only task-owned changes**

Use DevFlow `plan_task_commit`, then `commit_task_owned_changes` with message `refactor(lifecycle): establish flexible guardrail foundation`.

- [ ] **Step 5: Integrate/finalize the child if DevFlow permits the normal local terminal path**

Finalize DVF-0706 into local `develop` with fresh focused verification evidence. Preserve the workspace if finalization reports a real safety/recovery blocker.
