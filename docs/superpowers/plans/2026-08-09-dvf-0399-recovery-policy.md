# DVF-0399 Recoverable Tool Error Taxonomy Plan

**Goal:** Define one machine-readable recovery taxonomy and deterministic bounded policy for DevFlow tool failures without implementing the recovery engine itself.

**Architecture:** Add a pure `toolRecoveryPolicy` module that owns error-code/status classification, strategy metadata, loop detection, and recovery budgets. API errors, prepared-edit results, and MCP tool-job status/result guidance consume that module. Existing user-facing fields remain additive/backward compatible.

## Constraints
- Never auto-replay the same failed payload + strategy unchanged.
- Source/revision/anchor changes require fresh source evidence and a fresh preview before mutation.
- Ambiguity, integration conflicts, safety guards, and unrelated dirty-tree failures require a decision.
- Recovery terminates deterministically on budget exhaustion or repeated fingerprint.
- This card does not execute automatic recovery; DVF-0400 owns the recovery engine.

## Task 1 — Pure taxonomy and budget
- Create `src/server/services/toolRecoveryPolicy.ts`.
- Create `tests/server/toolRecoveryPolicy.test.ts` with table-driven code→category/strategy cases.
- Cover automatic: stale context/cache refresh, bounded batch split, pending-result wait, search fallback, timeout scope change.
- Cover refresh+repreview: file/content/base revision/anchor/plan stale cases.
- Cover decision-required: ambiguity, conflict, safety/path, dirty unrelated workspace/tree, consumed mutation plans.
- Cover terminal unknown/validation failures.
- Cover max recovery steps and same code+strategy+payload fingerprint loop detection.

## Task 2 — API error metadata
- Modify `src/server/services/api.ts` so known errors expose normalized top-level `recovery` metadata.
- Preserve explicit `details` and existing `retryable` behavior.
- Add focused assertions that known safety/source-change errors cannot be interpreted as auto-apply.

## Task 3 — Prepared edit consumption
- Modify `src/server/services/preparedEditService.ts` to derive recovery category/strategy from the shared policy while preserving legacy `action`, `retrySamePayload=false`, and guidance fields.
- Prove stale plans require refresh+repreview and consumed plans require decision.

## Task 4 — MCP tool-job consumption
- Modify `src/server/services/mcpToolJobService.ts` to expose recovery metadata on queued/running/timed-out/failed job status where available and generate `nextAction` from policy guidance instead of ad-hoc retry advice.
- Failed status reads the persisted terminal result code when available; no job is automatically retried in this card.

## Verification
- Run new table-driven policy tests.
- Run prepared-edit and MCP tool-job queue tests.
- Run targeted TypeScript compile or project typecheck, separating any pre-existing unrelated baseline failures.
- Review diff for any auto-apply/replay behavior; none is allowed in DVF-0399.
