# MCP Surface Consolidation and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce DevFlow MCP latency by shrinking the real agent-facing tool contract, returning async job handles quickly, eliminating blocking branch reads, and avoiding wasteful deterministic recovery loops.

**Architecture:** Keep HTTP/service capabilities intact where they are still useful internally, but expose fewer first-class MCP intents. Merge duplicate tool intents into existing higher-level tools instead of relying on profiles to hide them. Preserve safety boundaries for destructive/external-effect operations, and verify before/after with the existing MCP surface audit/benchmark.

**Tech Stack:** TypeScript, Node.js, MCP SDK, Express, node:test.

## Global Constraints

- Do not solve the surface problem by switching profiles.
- `full` must itself become materially leaner.
- Remove deprecated/agent-runner MCP tools when equivalent task APIs already exist or the capability is no longer part of the ChatGPT workflow.
- Prefer merging duplicate single/batch/read variants into one high-level intent where schemas remain understandable.
- Keep edit, verify, git commit/push, worktree isolation/integration, task authoring/review, Jira/Figma authoring, and health workflows available.
- Preserve existing HTTP routes/services when removal from MCP does not require deleting backend capability.
- Async job tools should return a durable job handle after about 1 second rather than waiting 20 seconds.
- Git branch reads must not block the Node event loop on `spawnSync`.
- Deterministic batch-limit recovery must not report or invoke an external-agent recovery path.

---

### Task 1: Lock the desired MCP surface with RED tests

**Files:**
- Modify: `tests/server/devflowToolProfile.test.ts`
- Modify: `tests/server/mcpFetchErrors.test.ts`

**Interfaces:**
- Consumes: `getMcpToolList('full')`, `getMcpToolList('coding')`, MCP call handler.
- Produces: regression assertions for removed agent-only tools and fast async eager wait.

- [ ] Add assertions that the full MCP surface no longer contains legacy agent-runner tools, dedicated assignment tools, duplicate agent-context tool, or execution handoff tools.
- [ ] Add assertions that replacement capabilities remain through `get_task`, `update_task`, and normal worktree/task/git tools.
- [ ] Add a behavioral async-job test proving a pending non-command job is polled with an eager wait of about 1000 ms, not 20000 ms.
- [ ] Run the focused tests and confirm they fail for the intended reasons.

### Task 2: Consolidate the real MCP contract

**Files:**
- Modify: `src/server/contracts/devflowTaskTools.ts`
- Modify: `src/server/contracts/devflowContract.ts`
- Modify: `src/server/contracts/devflowExecutionTools.ts` or stop registering its agent-facing definitions.
- Modify: `src/server/contracts/mcpToolSurfaceClassification.ts`
- Modify: `scripts/benchmark-mcp-surface.ts`

**Interfaces:**
- Consumes: existing task routes including `get_task(mode="agent-context")` and `update_task(agent/model/effort)`.
- Produces: a smaller `devFlowToolDefinitions` / full MCP surface with no profile trick.

- [ ] Remove MCP definitions for legacy Agent Runner tools (`get_task_prompt`, `list_agent_runs`, `retry_agent_run`, `cancel_agent_run`, `complete_agent_run`).
- [ ] Remove `get_agent_task_context` because `get_task(mode="agent-context")` already provides the same intent.
- [ ] Remove `assign_agent` and `batch_assign_agent`; task assignment remains available through `update_task` and task batch mutation where applicable.
- [ ] Remove `resume_execution` and `handoff_execution` from the ChatGPT MCP contract because they are cross-agent orchestration rather than normal coding workflow tools.
- [ ] Remove obsolete aliases tied to removed tools.
- [ ] Update classification/audit expectations so removals are represented as completed consolidation, not future migration candidates.
- [ ] Re-run surface audit/benchmark and record tool/schema reduction.

### Task 3: Shorten async eager wait

**Files:**
- Modify: `src/server/mcp.ts`
- Test: `tests/server/mcpFetchErrors.test.ts`

**Interfaces:**
- Consumes: async tool job creation result with `jobId`.
- Produces: first result poll uses 1000 ms for every async tool; `get_tool_job_result` remains the normal long-poll completion path.

- [ ] Make the default eager wait 1000 ms for all async job tools.
- [ ] Remove the special-case distinction that leaves other tools at 20000 ms.
- [ ] Run the focused MCP tests and confirm the eager-wait test passes.

### Task 4: Make branch reads non-blocking

**Files:**
- Modify: `src/server/services/gitService.ts`
- Modify: `src/server/routes/devflow.ts`
- Create or modify: `tests/server/gitServiceBranch.test.ts`

**Interfaces:**
- Consumes: project root resolution and `git branch --list` semantics.
- Produces: async `getGitBranch` result with `{ root, current, branches }` and no synchronous child-process block on the request path.

- [ ] Add a test that exercises branch listing through the async route/service contract and verifies the same result shape.
- [ ] Introduce a focused async git runner for branch listing using `spawn`/`execFile` with timeout and bounded output.
- [ ] Convert the `/api/git/branch` route to await the async service.
- [ ] Keep mutation-heavy git operations unchanged unless required by typing.
- [ ] Run the focused git test and relevant route/type tests.

### Task 5: Make deterministic batch-limit recovery purely internal

**Files:**
- Modify: `src/server/services/toolRecoveryEngine.ts`
- Modify: `src/server/services/devFlowRecoveryRuntime.ts` only if needed.
- Modify: `tests/server/toolRecoveryEngine.test.ts`
- Modify: `tests/server/toolRecoveryRuntime.test.ts`

**Interfaces:**
- Consumes: `BATCH_BYTE_LIMIT` with `splitBatch` adapter.
- Produces: split/combine recovery with `externalAgentCalls: 0`, bounded internal attempts, and no invalid-recovery-output for valid deterministic splits.

- [ ] Add RED assertions that deterministic split recovery reports zero external-agent calls.
- [ ] Correct the recovery evidence accounting so deterministic adapters are internal operations.
- [ ] Ensure valid split/combine recovery returns a normal successful result; preserve structured partial results only when a deterministic split truly cannot satisfy the byte budget.
- [ ] Run recovery engine/runtime tests.

### Task 6: Verify before/after and integration safety

**Files:**
- Modify documentation only if measured results differ from prior assumptions.

**Interfaces:**
- Consumes: existing audit/benchmark/test presets.
- Produces: evidence that `full` itself is smaller and core workflows remain available.

- [ ] Run `test-mcp-tool-profile`, accounting for the known `.env full` baseline assertion by fixing the test to isolate configuration correctly if needed.
- [ ] Run `test-mcp-fetch-errors`.
- [ ] Run recovery tests.
- [ ] Run typecheck.
- [ ] Run `audit-mcp-tool-surface` and `benchmark-mcp-surface` and compare canonical count, full tool count, and schema bytes to 104 / 109 / 173705 bytes baseline.
- [ ] Inspect git diff and ensure no unrelated changes.
