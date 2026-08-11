## Task Context

- Before editing, read the named card with `get_task` using `mode="agent-context"`. Use the connected DevFlow tool descriptions and live schemas instead of guessed or hardcoded HTTP paths.
- Treat the returned current-task requirements, target files, acceptance criteria, verification, checklist, repository context, and compact task boundaries as authoritative for this implementation.
- If the DevFlow tool surface is unavailable, stop and report the blocker instead of guessing task state or endpoints.
- If UI Design Evidence exists, inspect both the frozen screenshot and the full structured spec before UI implementation. Follow the frozen preview id/revision with the advertised DevFlow UI preview read tool. The task-attached frozen revision remains authoritative unless the evidence itself is updated; do not silently substitute a newer latest revision.
