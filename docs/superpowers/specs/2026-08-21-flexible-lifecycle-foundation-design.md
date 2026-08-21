# Flexible Lifecycle Foundation Design

## Goal

Establish the shared DVF-0705 foundation so lifecycle state becomes descriptive/auditable rather than runtime authority. The foundation defines one canonical guardrail result model, makes lifecycle authority independent from verification quality and ordered lifecycle stages, and adds direct auditable reconciliation for stale lifecycle metadata.

## Scope

This slice changes only the shared model and core authority/reconciliation primitives. It does not change commit, finalization, review, manual move, restart, public contract, or break-glass behavior yet. Those consumers are Wave 2 work and will adopt this foundation after it is integrated.

The legacy ordered transition API in `executionSessionService` stays unchanged during this slice. Direct reconciliation is deliberately isolated in `executionLifecycleReconciliationService` so later consumers have one explicit migration target instead of adding more behavior to the old strict graph.

## Canonical guardrail model

A guardrail assessment separates four concepts:

- `hardBlockers`: operation safety or physical impossibility. These are the only issues that can mechanically deny a later operation.
- `debts`: unresolved quality/workflow truth such as failed, stale, pending, or missing verification. Debt is preserved exactly and never rewritten to GREEN.
- `warnings`: non-blocking observations that are useful to operators/clients but do not represent unresolved required work.
- `reconciliations`: audit records explaining when descriptive metadata was aligned directly to observed reality.

Each issue carries a stable `code`, `message`, `category`, optional operation scope, and optional `details`. The model is pure and has helpers to build/deduplicate an assessment and evaluate whether a specific operation is safe without turning an operation-specific blocker into a global lifecycle gate.

## Lifecycle authority

`computeLifecycleAuthoritySnapshot` keeps claim/workspace/execution identity and ambiguity as hard safety facts. Verification remains observable under `verification`, but verification batch status/freshness and lifecycle stage do not determine commit authority.

The snapshot exposes guardrail categories explicitly. Existing `hardBlockers`, `softDrift`, and `info` fields remain for compatibility in this foundation slice, while a canonical `guardrails` field becomes the migration target for Wave 2 consumers.

Commit readiness in the authority snapshot is redefined as a safety-readiness signal only: unique current authority, no conflicting in-flight durable operation, task-owned changes present, and ownership state readable. It must not require `stage === verifying` or authoritative/fresh verification. Verification problems become debt entries rather than authority blockers.

## Direct lifecycle reconciliation

Keep `recordExecutionLifecycleTransition` and `EXECUTION_LIFECYCLE_TRANSITIONS` unchanged for legacy callers and historical ordered transition semantics. Add `reconcileExecutionLifecycleStage` in the dedicated reconciliation service as the flexible primitive.

The direct primitive:

- requires a concrete non-compatibility target stage;
- requires completed observed evidence;
- accepts any current active lifecycle stage without consulting the ordered transition graph;
- records exactly one lifecycle transition evidence row carrying `directReconciliation: true` and `skippedStageValidation: true` so the existing lifecycle projection reads the observed state directly;
- records `fromStage`, `toStage`, reason, origin evidence, operation identity and sequence for auditability;
- is idempotent when the same origin evidence is replayed with identical target/reason/kind/operation;
- rejects conflicting reuse of the same origin evidence;
- never emits synthetic intermediate lifecycle transitions.

Generic `lifecycle-reconciliation` audit evidence remains separate and cannot change projected stage because lifecycle projection continues to read only lifecycle-transition evidence.

## Safety boundaries preserved

This foundation does not weaken multiple-active-execution ambiguity, cross-workspace authority conflicts, workspace/task identity mismatch, ownership epoch mismatch, or conflicting accepted/running durable operations. Those remain hard safety.

A verification batch being pending/failed/stale is quality debt, not concurrency by itself. The separate durable pending-operation list remains the concurrency signal.

## Testing

Focused tests prove:

1. Canonical guardrail model keeps hard blockers, debt, warnings, and reconciliations separate and supports operation-scoped safety.
2. Lifecycle authority remains hard-blocked for ambiguous/foreign authority, while verification quality and stage no longer make an otherwise safe commit unready.
3. Direct reconciliation can move from stale `created` state directly to `committed` with one marked transition, is idempotent, rejects conflicting replay, and emits no intermediate stages.
4. The legacy ordered `recordExecutionLifecycleTransition` still rejects an invalid skip, proving historical callers retain their existing behavior during this foundation slice.
5. Final SAFE batch runs the three focused suites plus TypeScript typecheck on one frozen candidate.
