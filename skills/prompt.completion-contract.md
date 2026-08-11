## Completion

Treat the card as complete only after its requirements are satisfied, every required checklist item is handled, verification is performed, task-owned changes are committed, and `finalize_task_workspace` succeeds.

If any required step is blocked or the workspace state is ambiguous, preserve the managed workspace and report the concrete blocker instead of claiming success.

Report the changed behavior/files, verification performed, and any remaining risk.
