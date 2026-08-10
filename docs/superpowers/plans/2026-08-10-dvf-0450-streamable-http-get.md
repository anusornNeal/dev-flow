# DVF-0450 Streamable HTTP GET Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route normal Streamable HTTP GET lifecycle requests through the existing stateful MCP session transport instead of accidental Express 404 responses.

**Architecture:** Keep one reusable MCP transport per session. Mount one tracked `/mcp` route for all methods; the wrapper accepts POST/GET, delegates valid-session GET to the SDK, creates sessions only from POST, and returns explicit protocol errors for missing/stale sessions or unsupported methods.

**Tech Stack:** TypeScript, Express, `@modelcontextprotocol/sdk`, Node test runner.

## Global Constraints

- Preserve POST session reuse and 202 notification behavior.
- Preserve stale-session 404 semantics.
- Leave legacy `/sse` unchanged.
- Keep transport telemetry payload-free.
- Do not push.

---

### Task 1: Lock GET routing semantics with failing tests

**Files:**
- Modify: `tests/server/mcpStreamableHttp.test.ts`
- Modify: `tests/server/mcpTransportMonitor.test.ts`

**Interfaces:**
- Consumes: `createReusableMcpHttpHandler(apiBaseUrl, profileOverride?, hooks?, options?)`
- Produces: regression expectations for GET SSE, stale-session 404, unsupported-method 405, and GET telemetry.

- [ ] **Step 1: Write failing routing and valid-session GET tests**

Update the test HTTP server to dispatch all `/mcp` methods to the reusable handler, then initialize a session and issue GET with `Accept: text/event-stream`, `mcp-session-id`, and `mcp-protocol-version`. Assert HTTP 200 and `text/event-stream`; cancel the body immediately.

- [ ] **Step 2: Write stale-session and unsupported-method expectations**

Assert GET with an unknown session ID returns 404. Assert PUT returns 405 and `Allow: GET, POST`.

- [ ] **Step 3: Write telemetry regression**

Route GET through the same tracker wrapper and assert the resulting summary records operation `other` with a non-error status for a valid GET while privacy flags remain unchanged.

- [ ] **Step 4: Run the focused tests and verify RED**

Run the two Streamable HTTP/transport monitor test files. Expected: failures because the current wrapper rejects GET and production routing remains POST-only.

### Task 2: Implement protocol-native GET handling

**Files:**
- Modify: `src/server/mcpStreamableHttp.ts`
- Modify: `server.ts`

**Interfaces:**
- Consumes: existing session map and SDK `StreamableHTTPServerTransport.handleRequest(req, res, parsedBody)`.
- Produces: GET support for existing sessions; 400 missing-session, 404 stale-session, 405 unsupported-method semantics.

- [ ] **Step 1: Allow GET and POST in the wrapper**

Reject methods other than GET/POST with `Allow: GET, POST`. Resolve the requested session before any new-session creation. For GET without `mcp-session-id`, return JSON-RPC HTTP 400. For unknown non-empty session IDs, retain HTTP 404.

- [ ] **Step 2: Restrict session creation to POST**

Only POST may call `ensureCapacity`, create/connect a new MCP server transport, and register the generated session ID. Valid-session GET reuses the existing entry and delegates directly to SDK `handleRequest`.

- [ ] **Step 3: Route production `/mcp` through one tracked handler**

Replace POST-only mounting with `app.all('/mcp', ...)` while retaining existing start time, parse timing, tracker hooks, and tracker completion. GET body classification remains `other`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run both focused test files; expect zero failures.

### Task 3: Verify integration and lifecycle safety

**Files:**
- Verify: `server.ts`
- Verify: `src/server/mcpStreamableHttp.ts`
- Verify: `tests/server/mcpStreamableHttp.test.ts`
- Verify: `tests/server/mcpTransportMonitor.test.ts`

- [ ] **Step 1: Run typecheck**

Run `typecheck`; expect exit 0.

- [ ] **Step 2: Run MCP transport benchmark/regression**

Run the repository MCP transport benchmark/regression preset if configured; expect no lifecycle or latency regression gate failure.

- [ ] **Step 3: Run fresh FULL verification**

Run `verify`; expect exit 0.

- [ ] **Step 4: Review diff and commit**

Confirm only DVF-0450 files changed, then commit the implementation/tests separately from the already committed design spec.

- [ ] **Step 5: Integrate into develop and reverify**

Use DevFlow workspace integration, run fresh integrated verification on `develop`, sync evidence, and close DVF-0450 without pushing.