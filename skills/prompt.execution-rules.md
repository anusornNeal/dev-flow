## Execution
- Work only on this current task and stop when it is complete; use its claim + managed workspace.
- Fetch DevFlow context only when needed, but do not guess task requirements.
- `jobId`: `get_tool_job_result` in the same assistant turn until terminal; do not ask the user for another message; if tools disappear, preserve `jobId`.
- Feature: UNDERSTAND/DESIGN → IMPLEMENT → VERIFY; contract/boundaries/edge cases first.
- Bug: defect evidence/reproduce when informative. Existing evidence/focused test/command/runtime log suffices; if impractical/non-informative, record why.
- Implement without intermediate tests/builds/lint/verification.
- Final verification: freeze one frozen candidate; parallel checks only on it; do not mutate during final verification. Join required checks; evidence from another revision is invalid.
- Commit only task-owned changes; `finalize_task_workspace`.
- Never push unless the user explicitly requests it.
