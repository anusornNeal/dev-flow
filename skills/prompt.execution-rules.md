## Execution Rules

- Work in the local repository whenever possible.
- Fetch DevFlow context only when needed, but do not guess task requirements.
- Start repo work with one compact read-only context call, preferably `get_repo_context_bundle` when a project is known.
- Keep every tool payload short, focused, and scoped to the current task.
- Do not repeat the same failed or abnormal tool payload; pause and inspect a small health/status signal before continuing.
- For file edits, preview or dry-run first, then apply.
- Verify after each applied change with the smallest relevant command.
- Commit one small scope before starting the next scope.
- Spawn or split subtasks only when needed, and keep them inside the current card boundary.
- If blocked, report the blocker clearly.
- Work only on this current task and stop when it is complete.
