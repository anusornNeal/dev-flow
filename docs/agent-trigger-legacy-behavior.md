# Agent Trigger Legacy Behavior

Before the `agent_runs` refactor, DevFlow triggered agents from the task move/update route when a task entered `todo` from another status.

- The trigger only ran for tasks with an assigned `agent`.
- Existing status transition validation still ran before the trigger.
- The route used `task.activeAgent` as the active lock and skipped work when another `todo` or `in-progress` task in the same project already had `activeAgent`.
- The route set `task.activeAgent = task.agent`, then spawned `scripts/trigger-agent.bat`.
- The trigger script called `src/runner.ts`, which fetched the compiled prompt from `http://localhost:3000/api/tasks/:id/prompt`.
- The runner appended the full prompt to the CLI command arguments.
- If spawning failed, DevFlow logged the error, but there was no durable run record and the task could remain locked until manually cleared.
- There was no first-class retry, cancel, run history, prompt file, or run log path.
