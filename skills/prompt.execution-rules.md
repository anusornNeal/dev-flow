## Execution

- Establish or reuse the authoritative task claim and DevFlow-managed workspace before mutating files.
- Work only on this current task and stop when it is complete. Do not absorb unrelated dirty files or another worker's WIP.
- Fetch DevFlow context only when needed, but do not guess task requirements. Inspect the repository only as needed and follow the live DevFlow tool descriptions/schemas for edits and verification.
- If a DevFlow operation returns a durable `jobId`, continue with `get_tool_job_result` in the same assistant turn until terminal; do not ask the user for another message just to continue it. If tool connectivity disappears, preserve the `jobId` for recovery instead of replaying the operation.
- For testable behavior changes, use exactly two logical verification phases, RED → IMPLEMENT → GREEN: run one focused RED before implementation, make all required changes without intermediate tests/builds/lint, then enter one final risk-appropriate GREEN after implementation is complete.
- Before GREEN fan-out, freeze one verification candidate/revision. Independent required GREEN checks may run in parallel only against that same frozen candidate; do not mutate the task/workspace while the GREEN batch is active. Join all required checks and complete only when every mandatory check succeeds. Evidence from another revision is invalid. This parallel batch is still one logical final GREEN phase; recovery reruns after failure, staleness, or infrastructure interruption are exceptions.
- Satisfy the card requirements, handle every required checklist item, and verify the changed behavior before completion.
- Commit only task-owned changes, then finalize the task through DevFlow with `finalize_task_workspace`.
- Never push unless the user explicitly requests it.
