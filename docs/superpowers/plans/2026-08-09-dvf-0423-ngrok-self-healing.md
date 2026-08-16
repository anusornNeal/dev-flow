# DVF-0423 Ngrok Self-Healing Implementation Plan

> **Historical / superseded:** This dated plan documents the retired tunnel implementation. Current runtime guidance is `docs/runtime-supervisor.md`; DevFlow now uses the persistent zrok Agent Service/reserved-share lifecycle. Do not execute this plan against the current runtime.

> **For agentic workers:** Implement inline in the isolated DevFlow worktree with TDD and guarded edits.

**Goal:** Keep the DevFlow API running while automatically relaunching an unexpectedly exited ngrok child with bounded exponential backoff, and expose compact supervisor diagnostics that distinguish API and tunnel lifecycle state.

**Architecture:** Persist the parent supervisor's child-process lifecycle in a small `.devflow` state file owned by `scripts/start-all.ts`. Put state serialization and diagnostic derivation in a focused shared library so the server can read it without coupling supervisor logic to MCP routes. The launcher schedules ngrok-only recovery on unexpected exit/spawn failure, suppresses recovery during intentional shutdown, and preserves the existing dedicated server restart-ticket path unchanged.

**Tech Stack:** TypeScript, Node child_process, existing DevFlow local `.devflow` runtime state, node:test/assert verification scripts.

## Global Constraints

- Personal use; do not add authentication, OAuth, bearer tokens, or API keys for `/mcp`.
- Keep `/sse` behavior unchanged.
- Do not change task/git/Steno/job business logic.
- Resolve paths through DevFlow helpers; do not hardcode machine paths.
- Never push unless explicitly requested.

### Task 1: Supervisor state and diagnostics model

**Files:**
- Create: `src/lib/devFlowSupervisor.ts`
- Test: `tests/server/devFlowSupervisorState.test.ts`

- [ ] Write failing tests for state round-trip, per-child lifecycle updates, both-healthy, API-healthy/tunnel-restarting, and API-down/tunnel-healthy diagnostic summaries.
- [ ] Run the focused tests and confirm RED because the supervisor module does not exist.
- [ ] Implement versioned supervisor state read/write/update helpers and pure compact diagnostic derivation.
- [ ] Run the focused tests and confirm GREEN.

### Task 2: Ngrok recovery policy and launcher integration

**Files:**
- Modify: `scripts/start-all.ts`
- Modify: `scripts/verify-start-all.ts`

- [ ] Add failing assertions for ngrok-only restart eligibility, shutdown suppression, exponential delays, cap behavior, and resolved restart settings.
- [ ] Run `npm run test:start-all` and confirm RED.
- [ ] Add fixed/default restart policy settings, ngrok restart timer/attempt tracking, stable-uptime reset, spawn-error recovery, duplicate-timer suppression, and supervisor-state writes.
- [ ] Keep `shouldRestartServerProcess` and ticket/token server replacement behavior unchanged.
- [ ] Run `npm run test:start-all` and confirm GREEN.

### Task 3: Runtime diagnostics and operator documentation

**Files:**
- Modify: `src/server/services/mcpToolMonitor.ts`
- Modify: `tests/server/mcpToolMonitor.test.ts`
- Modify: `docs/runtime-supervisor.md`
- Modify: `README.md`

- [ ] Add a failing monitor test that expects compact `runtimeSupervisor` diagnostics from persisted supervisor state.
- [ ] Expose the shared diagnostic summary from `getDevFlowDiagnostics` without changing MCP transport/business behavior.
- [ ] Document automatic ngrok recovery, bounded retry timing, intentional shutdown suppression, and diagnostic meanings.
- [ ] Run focused monitor/start-all/supervisor tests, repository typecheck, and build.

### Task 4: Final verification and integration

- [ ] Inspect the final diff for scope creep and confirm no authentication or MCP transport semantics changed.
- [ ] Commit the verified scope explicitly.
- [ ] Integrate the isolated workspace into local `develop` without push.
- [ ] Attach verification evidence and close DVF-0423 using local/manual workflow override if only remote-publication gates remain.
