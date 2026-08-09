# DVF-0400 Bounded Recovery Engine Plan

**Goal:** Execute the policy-approved recoveries from DVF-0399 internally so known transient/tool-infrastructure failures do not require extra agent strategy round trips, while preserving every existing safety guard.

## Architecture
- Add a pure orchestration layer `toolRecoveryEngine.ts` that owns retry budget, loop fingerprints, compact recovery evidence, and strategy dispatch.
- The engine receives injected safe adapters; it never reads/writes paths, applies edits, or bypasses revision/Git guards itself.
- Automatic strategies may retry only with a changed payload/strategy or return a completed pending result.
- `refresh-repreview` strategies may refresh source and produce a fresh preview, but the engine always stops before mutation and requires an explicit apply step.
- Decision-required/terminal policies stop immediately with structured output.

## Recovery adapters
- `splitBatch`: return smaller semantically equivalent chunks plus a safe combine function.
- `refreshContext`: return a refreshed payload/context handle/file reference.
- `waitResult`: bounded long-poll and return the already-running job result.
- `fallbackSearch`: return a payload selecting a validated fallback backend/strategy.
- `refreshPreview`: re-read/re-anchor/reprepare and return fresh preview evidence; never apply.

## TDD fixtures
1. BATCH_BYTE_LIMIT splits once and succeeds without replaying the oversized payload.
2. CONTEXT_HANDLE_STALE / EDIT_REF_STALE refreshes evidence and retries only where policy permits.
3. JOB_PENDING resolves through one bounded wait instead of external status/log polling.
4. RIPGREP_UNAVAILABLE switches only to validated fallback search.
5. FILE_CHANGED_SINCE_READ / ANCHOR_MOVED produces fresh preview and stops before apply.
6. AMBIGUOUS_MATCH/safety cases stop without calling adapters.
7. Max-step and same code+strategy+payload loop detection terminate deterministically.
8. Recovery evidence contains codes/strategies/outcomes/call counts only; no raw payloads.
9. Benchmark manual recovery external calls versus engine automatic steps.

## Verification
- New engine suite + existing policy/prepared-edit/job suites.
- Targeted TypeScript compile.
- Diff review confirms no source-changing adapter is called by the engine after refresh+repreview.
