# Implementation Plan: Per-Agent Auto Work Queue Orchestration

**Task:** DVF-0224
**Branch:** `refactor/per-agent-auto-work-queue`
**Spec:** `docs/superpowers/specs/2026-06-19-per-agent-auto-work-queue-design.md`

## Ordering Rationale

The work is ordered by dependency: repository helpers first (everyone needs them), then trigger lock (gating depends on helpers), then queue drain (depends on lock), then runner capture (independent), then failure handling (depends on understanding callback flow), then settings drain (depends on queue drain), then UI (depends on runner data), then tests.

## Step 1: Repository helpers — agentRunRepository.ts

- Add `getActiveRunForProjectAndAgent(projectId: string, agent: string): Promise<AgentRun | null>`
- Add `getActiveRunSummariesPerProject(projectId: string): Promise<Map<string, string>>`
- Both query `agent_runs` where status NOT IN completed/failed/cancelled
- Use parameterized queries (same pattern as existing helpers)

## Step 2: Schema index — schema.sql

```sql
CREATE INDEX IF NOT EXISTS idx_agent_runs_project_agent_status
ON agent_runs(projectId, agent, status);
```

## Step 3: Trigger lock — routes/tasks.ts `triggerTaskAgent`

- Replace `getActiveRunForProject(task.projectId)` with `getActiveRunForProjectAndAgent(task.projectId, task.agent)`
- Keep same-task duplicate protection as-is
- When agent is busy: append to task log, return early, no run created

## Step 4: Queue drain — routes/tasks.ts `continueTaskQueueForProject`

- Fetch all `todo` tasks with agent assigned, sorted by createdAt
- Fetch active-run summaries via `getActiveRunSummariesPerProject`
- Loop through tasks; skip if agent busy; try to trigger; continue loop
- Return after evaluating all tasks

## Step 5: Runner stdout capture — runner.ts

- Modify generated launch script to redirect stdout/stderr to `output.log`
- On process exit, read last 50 lines, write to `agent.log` with `--- FINAL AGENT OUTPUT ---` header
- Append callback metadata after output section
- Call completion callback last

## Step 6: Failure handling — routes/tasks.ts `applyAgentCompletionCallback`

- Default `failed`/`cancelled` outcomes to move task to `todo`
- Preserve explicit `moveTo` override
- Keep `success` default as `ready-for-review`

## Step 7: Settings enable drain — routes/settings.ts

- After enabling Auto Work, call `continueTaskQueueForProject` per project
- The refactored drain (Step 4) already handles multi-agent starting

## Step 8: UI markers — TaskCard.tsx, TaskDetailsDrawer.tsx

- TaskCard: add queued/busy badge when latest run status indicates busy
- TaskDetails: display final agent output from `agent.log` inline
- Handle missing/no-capture state gracefully

## Step 9: Tests

Write backend tests in existing test framework:

| Test | Coverage |
|---|---|
| Different agents concurrent | Two agents, same project, both start |
| Same agent queues | Two tasks same agent, only first starts |
| Queue drains all | Three tasks different agents, all start |
| Completion continues | After success, next eligible card starts |
| Failure returns to todo | Failed completion, task moves to `todo` |
| Settings enable drains | Enable auto work, all eligible cards start |
| Stdout capture | Fake agent unique line appears in `agent.log` |
| Tail capture | 100+ lines, only last 50 in `agent.log` |

## Step 10: Verify

- Run existing test suite
- Manual: create 3 todo cards with Codex/Antigravity/Claude, enable Auto Work, verify independent launch
- Manual: two cards same agent, verify queuing
- Manual: force error, verify return to `todo`
- Manual: check `agent.log` for final output
