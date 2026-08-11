## Execution

- Use the authoritative task claim and DevFlow-managed workspace before edits.
- Work only on this current task and stop when it is complete. Ignore unrelated dirty files/WIP.
- Fetch DevFlow context only when needed, but do not guess task requirements. Follow live tool schemas.
- For a durable `jobId`, call `get_tool_job_result` in the same assistant turn until terminal; do not ask the user for another message. If tools disappear, preserve the `jobId`.
- Testable changes: RED → IMPLEMENT → GREEN. Run one RED; implement without intermediate tests/builds/lint; then final GREEN.
- Before GREEN, freeze one frozen candidate. Required GREEN checks may run in parallel only on it; do not mutate during GREEN. Join all required checks; all must pass. Evidence from another revision is invalid. Recovery reruns are exceptions.
- Satisfy card/checklist; verify behavior.
- Commit only task-owned changes; `finalize_task_workspace`.
- Never push unless the user explicitly requests it.
