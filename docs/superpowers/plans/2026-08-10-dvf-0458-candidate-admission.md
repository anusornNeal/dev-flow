# DVF-0458 Candidate Admission Plan

> **For agentic workers:** execute with TDD, guarded edits, no restart, no push.

**Goal:** Make `run_project_command` admission cheap: return valid cache hits before any candidate snapshot exists, and move cache-miss candidate Git work to an asynchronous durable preparation phase.

**Architecture:** Admission resolves the same revision/config/env/output-aware execution identity already used by command caching. A fresh cache hit is persisted as an immediately succeeded durable job with zero candidate/process work. A miss persists only the admission identity, enters the existing queue, and after claim prepares the immutable candidate asynchronously. Candidate binding must still match the captured admission identity; if the workspace changed before/during preparation, the job fails stale instead of verifying a different revision. Candidate metadata is persisted under the worker lease before command execution so restart cleanup remains durable.

### Task 1 — RED: cache and admission
- [ ] Add a cache-hit durable-job regression proving no candidate id/root is created and no runner/process executes.
- [ ] Add a cache-miss regression proving persisted queued args contain admission identity but no candidate until the job is active.
- [ ] Update candidate lifecycle regressions so queued cancel/supersession no longer expects pre-created roots.

### Task 2 — Async candidate lifecycle
- [ ] Add async Git candidate creation/release with `spawn(..., shell:false)`, bounded timeouts, abort support, async worktree cleanup, and source-revision recheck.
- [ ] Add async project-command candidate preparation that binds against the captured admission identity.
- [ ] Persist the prepared candidate in durable running-job args under the current worker lease before spawning verification.
- [ ] Make interactive cancel/supersession schedule legacy-candidate cleanup asynchronously rather than running sync Git.

### Task 3 — Cache-first admission
- [ ] Expose one project-command admission preflight using the exact execution/cache identity rules.
- [ ] Complete valid cache hits directly as terminal durable jobs before single-flight/queue/candidate creation.
- [ ] Persist sanitized admission identity on misses and use it for single-flight/recovery consistency.

### Task 4 — Telemetry and resilience
- [ ] Add `candidatePreparation` as its own phase between queue and execution; keep admission/queue/workspace/capacity/execution/response disjoint.
- [ ] Prove cancellation during candidate setup aborts/cleans the candidate and terminal state wins.
- [ ] Prove a workspace revision change before candidate preparation never verifies the newer workspace under the older request identity.
- [ ] Update isolation diagnostics to expose aggregate candidate-preparation timings without paths/payloads.

### Task 5 — Verify and integrate
- [ ] Run project-command/cache/candidate/job/recovery/monitor focused suites and typecheck.
- [ ] Run session-isolation benchmark if repository preset permits without restart.
- [ ] Commit only DVF-0458 scope, integrate latest local `develop`, post-integrate verify, sync evidence, close card, cleanup worktrees.
