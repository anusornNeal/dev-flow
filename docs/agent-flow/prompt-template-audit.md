# Prompt Template Audit

This document traces the current agent prompt generation, lifecycle, and queueing behavior, and maps how it will be replaced by the new DevFlow-owned orchestration (DVF-0074).

## 1. Current State Locations
- **Prompt Generation:** `buildTaskPrompt` in `src/server/services/taskService.ts`.
- **Status Update to 'todo':** Handled by `PATCH /api/tasks/:id` and `PUT /api/tasks/:id` routes in `src/server/routes/tasks.ts`, which then calls `maybeTriggerTaskAgent`.
- **Agent Run Creation:** `createAgentRun` is called inside `triggerTaskAgent` in `src/server/routes/tasks.ts`.
- **Agent Runner:** `scripts/trigger-agent.bat` proxies execution via `npx tsx` to `src/runner.ts`.
- **Next Task Selection:** Currently handled entirely by the agent through the hardcoded prompt.

## 2. Hardcoded Six-Step Flow Replacement Plan

The following old instructions are currently hardcoded in `buildTaskPrompt` and will be replaced as follows:

| Old Instruction | Replacement Owner |
|-----------------|-------------------|
| **Step 1:** Immediately use the Dev Flow MCP tool to move this task to 'in-progress' status. | **DevFlow Lifecycle:** The backend will move the task to `in-progress` *before* generating the prompt.md in `triggerTaskAgent` (`src/server/routes/tasks.ts`). |
| **Step 2:** Read the task details. | **DevFlow Prompt Rendering:** Task details will be fully rendered into `prompt.md` via the new `promptTemplateService.ts`. The agent will not need to fetch it via MCP. |
| **Step 3:** If the task has checklist items or subtasks, use the invoke_subagent tool to call subagents for them. | **DevFlow Prompt Rendering:** Handled by the `prompt.subtasks` and `prompt.checklist` template sections. Agents will no longer be forced to automatically spawn subagents just because subtasks exist. |
| **Step 4:** When done, move the task to 'ready-for-review'. | **DevFlow Completion Handoff:** Handled by a new completion callback endpoint in `tasks.ts`, and runner exit behavior. |
| **Step 5:** Check if there are any other tasks in the 'todo' lane for this project. If there are, pick the oldest one, move it to 'in-progress', work on it, and repeat this loop until no 'todo' tasks remain. | **DevFlow Queue Orchestration:** Handled internally by DevFlow. When a task completes, DevFlow will evaluate `autoWork` and launch a completely new run/session for the next eligible task in `tasks.ts`. |

## 3. Next Steps
Subsequent implementation subtasks (DVF-0076 to DVF-0083) will introduce the `promptTemplateService.ts`, extract these hardcoded instructions into markdown skills in `skills/`, and modify `triggerTaskAgent` and runner launch logic to enforce the single-task-per-session requirement.
