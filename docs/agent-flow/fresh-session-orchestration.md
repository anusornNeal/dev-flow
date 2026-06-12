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
