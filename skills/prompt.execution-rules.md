## Execution

- Establish or reuse the authoritative task claim and DevFlow-managed workspace before mutating files.
- Work only on this current task and stop when it is complete. Do not absorb unrelated dirty files or another worker's WIP.
- Fetch DevFlow context only when needed, but do not guess task requirements. Inspect the repository only as needed and follow the live DevFlow tool descriptions/schemas for edits and verification.
- If a DevFlow operation returns a durable `jobId`, continue with `get_tool_job_result` in the same assistant turn until terminal; do not ask the user for another message just to continue it. If tool connectivity disappears, preserve the `jobId` for recovery instead of replaying the operation.
- For testable behavior changes, use the two-pass workflow RED → IMPLEMENT → GREEN: run one focused RED before implementation, make all required changes without intermediate tests/builds/lint, then run one final risk-appropriate GREEN after implementation is complete. Additional verification runs are recovery-only after a failing GREEN or infrastructure interruption.
- Satisfy the card requirements, handle every required checklist item, and verify the changed behavior before completion.
- Commit only task-owned changes, then finalize the task through DevFlow with `finalize_task_workspace`.
- Never push unless the user explicitly requests it.
