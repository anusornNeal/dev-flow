## Completion and board synchronization

When available, use `update_external_task_status` only as best-effort board synchronization: move the card to `in-progress` when starting, optionally to `ready-for-review` when useful, and to `done` when repository work is complete.

Status synchronization is advisory, not a blocking state machine. If that tool is missing, disconnected, or fails, continue investigating, implementing, testing, committing, and completing the repository task. Report the synchronization failure separately. You may complete the task even if an intermediate board move was skipped.

Finish by reporting what changed, verification performed, commits created if any, and any remaining risks or follow-up.