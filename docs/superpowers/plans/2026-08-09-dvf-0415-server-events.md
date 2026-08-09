# DVF-0415 Unified Server Events Implementation Plan

> **For agentic workers:** use the isolated DevFlow workspace, TDD, focused tests, and local-only commits; do not push unless the user explicitly asks.

**Goal:** Add one compact, versioned, reconnect-safe server event channel that invalidates affected UI data immediately while retaining bounded polling fallback.

**Architecture:** A frontend-agnostic in-process broker owns opaque stream-generation event IDs, a bounded replay ring, subscriber caps, and compact event shapes. `/api/events` exposes that broker as SSE with Last-Event-ID replay/reset, retry guidance, heartbeat comments, and disconnect cleanup. Core repositories/services publish domain invalidations at mutation boundaries. A single browser utility owns EventSource lifecycle/backoff and reactive refresh helpers; App and Observability subscribe selectively and retain 60-second fallback refresh.

## Task 1 — Event broker + SSE route
- [x] Write server tests for event version/shape/order, replay from Last-Event-ID, retry framing, disconnect cleanup, and subscriber cap.
- [x] Implement `serverEventService.ts` with bounded ring/subscribers and compact event types.
- [x] Implement `routes/events.ts` and register it under the existing `/api` request boundary.
- [x] Make reconnect generation-safe with opaque `streamEpoch.sequence` IDs and `stream.reset` when prior replay history belongs to another server generation.
- [x] Re-run server tests green.

## Task 2 — Domain publication
- [x] Add task change publication at repository mutation boundaries, including deletes/batches.
- [x] Add project/settings/cache/Atlas publication at their central persistence/invalidation boundaries.
- [x] Add MCP tool-job queued/running/terminal/cancelled lifecycle publication without heartbeat event spam.
- [x] Add per-project health regression publication only when the warning/error signature changes.
- [x] Verify payloads contain IDs/status/reasons only, never full task/job/Atlas/settings objects or secrets.

## Task 3 — Reusable client subscription + reactive UI
- [x] Write client utility tests using a fake EventSource: event dispatch, reconnect/backoff, cleanup, and fallback refresh.
- [x] Implement `src/lib/serverEvents.ts` as the EventSource lifecycle owner.
- [x] Update ObservabilityModal to refresh immediately on job/health/cache/task/reset events and use a 60-second fallback instead of 10-second-only polling.
- [x] Update App to selectively refresh tasks/projects/settings/Atlas on matching compact events, with 60-second bounded fallback.
- [x] Re-run focused client tests green.

## Task 4 — Verification
- [x] Server-event broker/SSE tests: 4/4 pass.
- [x] Client reconnect/reactive refresh tests: 3/3 pass.
- [x] Domain publisher + secret-safety integration test: 1/1 pass.
- [x] Workflow health regression suite: 9/9 pass; warm p95 ~58ms under the 750ms SLO.
- [x] Existing MCP queue/job regression suite: 19/19 pass.
- [x] Project-resolution + board paging/archive regressions pass.
- [x] Scoped TypeScript verification passes after excluding only unchanged baseline tests `tests/server/authoringSkillContent.test.ts` and `tests/server/localPatchService.test.ts`.
- [x] Built-in global typecheck re-confirmed the pre-existing DVF-0417 parser blocker at `tests/server/authoringSkillContent.test.ts:91`.
- [x] Inspect diff/status and prepare an 18-file local-only commit scope; `.devflow` verification helpers remain ignored.

**Post-plan workflow:** commit the verified scope in this isolated workspace, integrate locally into `develop`, attach evidence to DVF-0415, and do not push.
