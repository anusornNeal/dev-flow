# DevFlow Orchestration Architecture

This document describes the task execution flow in DevFlow, prioritizing a fresh-session orchestration model.

## 1. Task Triggering

- A task is moved to `in-progress` (either manually or by the continuation loop).
- DevFlow checks the `project.localPath` to ensure a working directory is available. If missing, the run is blocked.
- DevFlow creates a new `agent_run` record for the task. This guarantees every execution is isolated.

## 2. Prompt Rendering

- Once the task is marked as in-progress and a run is created, DevFlow renders the `prompt.md` file.
- The rendering uses a skill-composed prompt template pipeline defined in `config/prompt-pipeline.json`.
- It loads an ordered list of prompt fragments from `skills/prompt.*.md`.
- Interpolation occurs for `{agent}` to allow dynamic agent-specific behaviors, along with task and project variables (`run.id`, `task.title`, `project.localPath`, etc.).
- Missing templates are skipped gracefully.

## 3. Worker Execution

- DevFlow launches the worker (`runner.ts` spawns `cmd.exe /c start /wait ...`) to execute the task in a new, independent console window.
- The worker executes strictly what is in the rendered `prompt.md`.
- The prompt explicitly forbids the worker from managing DevFlow's status (e.g., pulling new tasks or changing status).

## 4. Completion Callback

- The runner waits for the child process window to close.
- When closed, it reads the exit code.
- The runner issues an HTTP POST to `/api/tasks/:id/agent-runs/:runId/complete` with `{ success: true/false }`.
- DevFlow updates the `agent_run` status to `succeeded` or `failed`.
- If successful, DevFlow marks the task as `ready-for-review`.

## 5. Queue Continuation

- During the completion callback, if `autoWork` is enabled, DevFlow inspects the same project for the oldest eligible `todo` task assigned to an agent.
- DevFlow triggers the next task natively, completely independent of the previous worker's session.
- A new fresh process loop (Trigger -> Prompt -> Execution) starts.

## 6. Model & Effort Resolution

- **Launch-Time Binding**: `model` and `effort` constraints are read only once per task execution, directly at worker launch (inside `runner.ts`).
- **Why not during the session?**: By locking them at process launch and ensuring a fresh session per task, workers cannot silently inherit or change reasoning effort or models mid-flow. This guarantees every single run acts strictly within its assigned bounds.

## 7. Customizing Prompt Skills

DevFlow's prompt pipeline can be modified without altering backend code.
- **Default Pipeline Order**: Found in `config/prompt-pipeline.json`, typical order is: `prompt.header`, `prompt.task-context`, `prompt.agent-specific.{agent}`, `prompt.project-rules`, `prompt.footer`.
- **Editing Templates**: To change instructions, simply open `skills/prompt.header.md` or any other target fragment and edit the markdown directly. The next run will immediately use your updated content.

## 8. Manual Verification

To manually verify the fresh session orchestration:
1. Create two `todo` tasks under the same project.
2. Set the first task to model `GPT-5.5` with effort `low`.
3. Set the second task to model `GPT-5.5` with effort `xhigh`.
4. Trigger the first task.
5. In `.devflow/runs/`, you will see a new run directory containing `prompt.md` and `agent.log` for the first task.
6. Verify the launch log states effort `low`.
7. Mark the task complete so auto-work picks up the second task.
8. Verify a separate run directory is created for the second task, and its launch log correctly outputs effort `xhigh`.

## 9. Example Prompt Outline

The final generated prompt passed to the agent includes standard instructions:
```markdown
# DEVFLOW TASK ASSIGNMENT
You are working as an autonomous agent to complete a task.

## TASK CONTEXT
Task: Implement User Login
...
## PROJECT RULES
...
## EXECUTION RULES
1. Work only from this prompt.
2. Do not change model or reasoning effort inside the session. DevFlow will start a new session for the next task.
3. Finish your work and exit cleanly.
```
