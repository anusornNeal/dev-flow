# Per-Agent Auto Work Queue Orchestration

**Date:** 2026-06-19
**Task:** DVF-0224
**Status:** Design (pre-implementation)

## Problem

DevFlow's Auto Work system uses a project-level lock: only one agent run can be active per project at a time. This means a busy Codex run blocks Antigravity and Claude from starting, even though they are independent agents capable of working simultaneously. The queue continuation also stops after the first triggered task instead of draining all eligible cards for available agents. Additionally, the final agent stdout/stderr output is not persisted to the run log, and failure handling does not consistently return cards to `todo`.

## Scope

No new agent providers. No broad prompt-template rewrite. No removal of manual retry/cancel APIs. Existing manual trigger, retry, cancel, completion callback, task lock override, and parent review blocker behavior must continue working.

## Design

### 1. Repository Layer — Agent Run Queries

**File:** `src/server/repositories/agentRunRepository.ts`

Two new helpers:

1. `getActiveRunForProjectAndAgent(projectId, agent)` — Returns a single active agent run (status NOT IN `completed`, `failed`, `cancelled`) matching both project and agent. Used as the per-agent availability check.

2. `getActiveRunSummariesPerProject(projectId)` — Returns a `Map<AgentName, RunId>` of all active runs for a project, keyed by agent. Used by queue drain to determine which agents are busy without N+1 queries.

**File:** `src/db/schema.sql`

New composite index:
```sql
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_agent_status
ON agent_runs(projectId, agent, status);
```

Keeps lock queries fast. The existing single-project index is preserved for backward compatibility.

### 2. Trigger Lock Refactor

**File:** `src/server/routes/tasks.ts`, function `triggerTaskAgent`

**Current behavior:** Calls `getActiveRunForProject(task.projectId)` — blocks any other agent in the same project.

**New behavior:** Replace with `getActiveRunForProjectAndAgent(task.projectId, task.agent)`. Only the same busy agent blocks the card. Same-task duplicate run protection is preserved as a separate earlier check.

**When the assigned agent is busy:**
- No agent run is created.
- Task status remains `todo`.
- A queued/busy entry is appended to the task log.
- Returns early with a clear `busy` signal.

This covers checklist items: **define-agent-availability**, **trigger-lock-refactor**, **same-agent-busy-queue**.

### 3. Queue Drain — All Available Agents

**File:** `src/server/routes/tasks.ts`, function `continueTaskQueueForProject`

**Current behavior:** Iterates eligible `todo` cards, triggers first one whose agent is available, returns immediately.

**New behavior:**
1. Fetch all `todo` tasks for the project with an assigned agent, sorted by `createdAt`.
2. Fetch active-run summaries per project (from Section 1).
3. For each eligible task:
   - If its assigned agent is busy, skip it.
   - If its assigned agent is free, call `triggerTaskAgent`.
   - After each successful trigger, the summary map is implicitly updated (the trigger creates an active run).
4. Loop continues until all eligible cards have been evaluated.
5. No card is evaluated twice in the same pass.

This covers checklist items: **queue-drain-all-agents**, **success-continuation**.

### 4. Settings Enable Drain

**File:** `src/server/routes/settings.ts`

**Current behavior:** `validateAutoWorkConfiguration()` runs preflight checks on all `todo` tasks system-wide. If validation passes, Auto Work is enabled, then `continueTaskQueueForProject` is called per project but breaks after the first trigger.

**New behavior:**
- Preflight validation remains unchanged (catches systemic issues before enabling).
- On enable, call the refactored `continueTaskQueueForProject` for each project with `todo` cards.
- The new loop (Section 3) already handles starting all available agents.

This covers checklist items: **settings-enable-drain**.

### 5. Runner Stdout Capture

**File:** `src/runner.ts`

**Current behavior:** Generated launch script (`launch.bat`) runs the agent command with `stdio: ignore`, then logs only exit code and calls completion callback.

**New behavior:**
1. Redirect agent process stdout/stderr to `output.log` (in the run directory).
2. On process exit, read the last 50 lines from `output.log`.
3. Write the tail to `agent.log` with a header `--- FINAL AGENT OUTPUT ---`.
4. Append exit code and completion callback metadata after the output section.
5. Finally call the completion callback.

The existing interactive terminal window is preserved — `output.log` is written in parallel. The tail extraction happens after the process exits, so `agent.log` is always complete before the callback fires.

**File:** `scripts/trigger-agent.bat`, `scripts/invoke-agent-trigger.ps1`

No changes to these proxy scripts. The output capture lives entirely in the generated launch script within `runner.ts`.

This covers checklist items: **capture-final-stdout**, **callback-after-flush**, **success-and-failure**, **avoid-secret-leak**.

### 6. Failure Handling Normalization

**File:** `src/server/routes/tasks.ts`

**Current behavior:** `applyAgentCompletionCallback` with `failed` or `cancelled` outcome defaults to keeping the task at `in-progress` unless an explicit `moveTo` target status is provided.

**New behavior:** Default `failed` and `cancelled` outcomes to move the task to `todo`. Explicit `moveTo` still overrides this default. This ensures failed/cancelled work returns to `todo` without creating silent auto-retry loops.

This covers checklist items: **failure-handling**.

### 7. UI State Visibility

**Files:** `src/components/TaskCard.tsx`, `src/components/TaskDetailsDrawer.tsx`

**TaskCard:**
- Running: existing active-agent badge (no change).
- Queued/busy: add a "queued (agent busy)" badge when the latest run status indicates the card is queued due to agent unavailability.
- Failed: existing error styling (no change).
- Ready-for-review: existing badge (no change).

**TaskDetails auto-work tab:**
- Display the `--- FINAL AGENT OUTPUT ---` section from `agent.log` inline.
- If no output is captured, show "No final output captured" — handles old runs gracefully.

This is a thin presentation layer. All data comes from the backend (Section 5). No queue logic lives in the frontend.

This covers checklist items: **log-final-message-ui**, **ui-status-visibility**.

### 8. Testing

New backend tests in the existing test framework:

| Test | What it proves |
|---|---|
| `Different agents run concurrently` | Codex and Antigravity can both have active runs in the same project |
| `Same agent queues second card` | Two cards assigned to Codex: only the first starts, second stays `todo` with busy log |
| `Queue drains all available agents` | Three cards for three different agents all start in one queue pass |
| `Completion continues queue` | After success, queue continuation starts the next eligible card |
| `Failure returns to todo` | Failed completion moves card back to `todo`, run outcome recorded |
| `Settings enable drains all` | Enabling Auto Work starts all eligible cards across agents |
| `Final stdout captured in agent.log` | Fake agent prints unique line; verified present in `agent.log` |
| `Final stdout tail capture` | Agent printing 100+ lines; only last 50 appear in `agent.log` |

This covers checklist items: **tests-orchestration**, **manual-regression**.

## Backward Compatibility

- Existing manual trigger, retry, cancel, completion callback, task lock override, and parent review blocker behavior are preserved.
- Old runs without captured final output render cleanly in the UI.
- Existing schema indexes remain; the new index is additive.
- The existing `getActiveRunForProject` helper is not removed — it may have other callers. The trigger function simply switches to the new helper.
