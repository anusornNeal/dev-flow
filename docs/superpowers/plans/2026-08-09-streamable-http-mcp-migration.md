# Streamable HTTP MCP Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add stateless Streamable HTTP at `/mcp`, prove fresh reconnect across supervised restart, and make persistent MCP job recovery deterministic without removing legacy `/sse` during soak.

**Architecture:** Keep the existing `createDevFlowMcpServer(apiBaseUrl)` tool layer authoritative and wrap it with a new Streamable HTTP transport adapter that creates fresh stateless transport state per MCP HTTP request. Preserve legacy `/sse` unchanged as a fallback. Restart/job work reuses existing persistent SQLite-backed tool jobs, supervisor restart state, runtime identity diagnostics, and recovery policy; no authentication is introduced.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk` 1.29.x, Node test runner, DevFlow supervisor/job persistence.

## Global Constraints

- Personal use 100%.
- NO AUTH.
- Do not add OAuth, login/session authentication, bearer tokens, API keys, or any authentication requirement for `/mcp` or existing DevFlow tools.
- `/sse` must remain usable during migration.
- `/mcp` must not depend on legacy `activeTransports` SSE state.
- Reuse existing task/git/Steno/job business logic unchanged unless transport/lifecycle correctness requires a narrow adjustment.
- Local repo paths must resolve through DevFlow; no machine path may be hardcoded in source/docs.
- Do not remove primary SSE until DVF-0424 real-usage soak gates pass.

---

### Task 1: Add focused Streamable HTTP protocol regression tests

**Files:**
- Create: `tests/server/mcpStreamableHttp.test.ts`
- Modify: `scripts/verify.ts` only if the repository verification runner does not auto-include the new test.

**Interfaces:**
- Consumes: `createDevFlowMcpServer(apiBaseUrl)`.
- Produces: regression coverage for initialize, tools/list, tools/call, two independent clients, and fresh-client reconnect semantics.

- [ ] **Step 1: Write a failing initialize/list/call test** that boots an Express fixture with `/api/capabilities` and `/mcp`, sends MCP initialize, `tools/list`, and `tools/call get_capabilities`, and asserts valid JSON-RPC responses.
- [ ] **Step 2: Run the focused test and verify RED** because `/mcp` does not exist yet.
- [ ] **Step 3: Add two-client coverage** proving client A and client B can initialize/list/call independently without a shared `mcp-session-id` requirement.
- [ ] **Step 4: Add fresh-client coverage** proving a newly created client/request sequence works after the previous client is discarded.

### Task 2: Implement stateless Streamable HTTP `/mcp`

**Files:**
- Modify: `server.ts`
- Modify: `src/server/mcp.ts` only if a transport-facing helper is needed.
- Modify: `src/server/contracts/devflowContract.ts` for transport metadata/version only.
- Modify: `package.json` / `package-lock.json` only if the installed SDK API requires it.

**Interfaces:**
- Consumes: `createDevFlowMcpServer(apiBaseUrl)` and SDK `StreamableHTTPServerTransport`.
- Produces: `POST /mcp` primary migration endpoint; optional protocol-required GET/DELETE handling returns spec-compatible responses without authentication.

- [ ] **Step 1: Inspect installed SDK Streamable HTTP API** and use the installed v1.29.x contract rather than memory.
- [ ] **Step 2: Implement minimal stateless transport handling** with a fresh MCP server + transport per request and `sessionIdGenerator: undefined` (or the installed SDK equivalent), then delegate the request to the transport.
- [ ] **Step 3: Preserve `/sse` code path and active transport map unchanged.**
- [ ] **Step 4: Add bounded transport input/body handling only if required; do not add identity/authentication.**
- [ ] **Step 5: Run protocol tests and legacy SSE regression tests to GREEN.**

### Task 3: Expose transport/runtime capability evidence

**Files:**
- Modify: `src/server/contracts/devflowContract.ts`
- Modify: `src/server/services/runtimeIdentityService.ts` only if current transport metadata cannot express migration mode.
- Test: `tests/server/runtimeIdentityDiagnostics.test.ts`

**Interfaces:**
- Produces: capability/diagnostic metadata showing `/mcp` available while `/sse` remains fallback.

- [ ] **Step 1: Add failing assertions** for transport metadata including Streamable HTTP availability and legacy SSE migration fallback.
- [ ] **Step 2: Update runtime/capability metadata minimally** without changing existing tool schemas.
- [ ] **Step 3: Run runtime identity/schema fidelity tests.**

### Task 4: Harden persistent job restart recovery

**Files:**
- Modify: `src/server/services/mcpToolJobService.ts`
- Modify: `src/server/repositories/mcpToolJobRepository.ts` only if persisted state lacks the required recovery classification.
- Modify: `src/lib/devFlowRestart.ts` / `src/server/services/restartService.ts` only if observable restart state needs a narrow extension.
- Test: `tests/server/mcpToolJobQueue.test.ts`
- Test: `tests/server/devflowRestartRoute.test.ts`

**Interfaces:**
- Consumes: persisted tool-job lifecycle, lease/heartbeat, recovery policy, supervisor restart state.
- Produces: deterministic post-restart state for pre-restart queued/running jobs and no duplicate recovered execution.

- [ ] **Step 1: Write failing restart-recovery tests** for queued/running/completed jobs and duplicate recovery attempts.
- [ ] **Step 2: Verify current startup recovery behavior** and change only gaps: recoverable jobs may be requeued once; non-survivable jobs must become explicit terminal/recoverable state rather than remain falsely running.
- [ ] **Step 3: Ensure recovery is idempotent** using persisted job identity/claim/recovery classification so reconnect/retry cannot execute one accepted job twice.
- [ ] **Step 4: Extend restart status assertions** so accepted/restarting/healthy/failed state remains queryable after reconnect.
- [ ] **Step 5: Run focused queue/restart tests.**

### Task 5: Add `/mcp` restart/reconnect integration coverage

**Files:**
- Extend: `tests/server/mcpStreamableHttp.test.ts`
- Extend: `tests/server/devflowRestartRoute.test.ts` if helper reuse is cleaner.

**Interfaces:**
- Produces: automated proof of `connect -> list -> call -> restart boundary -> fresh connect -> list -> call` without old SSE session recovery.

- [ ] **Step 1: Build a process/fixture boundary that creates runtime instance A and performs initialize/list/get_capabilities.**
- [ ] **Step 2: Simulate/execute the supported restart transition and create runtime instance B.**
- [ ] **Step 3: Use a brand-new Streamable HTTP client/request sequence against B and assert list/call succeeds.**
- [ ] **Step 4: Assert stale transport/client state from A has no registry entry required by B.**

### Task 6: Verification, commits, integration, and card state

**Files:**
- No production file changes unless verification exposes a regression.

- [ ] **Step 1: Run focused `/mcp`, SSE, restart, job queue, runtime identity, and schema fidelity tests.**
- [ ] **Step 2: Run `typecheck`.**
- [ ] **Step 3: Run fresh FULL verify.**
- [ ] **Step 4: Commit scoped implementation in the managed workspace.**
- [ ] **Step 5: Integrate workspace into local `develop` without push.**
- [ ] **Step 6: Restart DevFlow through the supported supervisor and smoke-test the newly loaded `/mcp` transport.**
- [ ] **Step 7: Mark DVF-0420 and DVF-0422 done with verification evidence; update DVF-0419 to reflect children 1-4 complete but leave DVF-0424 blocked until real ChatGPT soak.**
- [ ] **Step 8: Tell the user to change the ChatGPT MCP URL from `/sse` to `/mcp` only after the post-restart `/mcp` smoke succeeds. Do not remove `/sse` yet.**
