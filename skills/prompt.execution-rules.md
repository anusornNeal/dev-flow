## Execution Rules

- Work in the local repository and DevFlow-managed workspace selected for the current task whenever possible.
- Fetch DevFlow context only when needed, but do not guess task requirements.
- Keep tool payloads short, focused, and scoped to the current task. Do not derive or persist a managed workspace's physical path.
- Do not repeat the same failed or abnormal mutation payload unchanged. Inspect a small current status/error signal and change the strategy, source revision, identifier, or payload before retrying.
- Use the current advertised DevFlow tool surface and its live schemas for guarded repository mutation and verification. Prefer the smallest risk-matched verification that proves the current change, while preserving any required final gate.
- When an async DevFlow tool returns a durable `jobId`, call `get_tool_job_result(jobId, waitMs=30000)` immediately and keep bounded polling in the same assistant turn until terminal whenever the DevFlow tool surface remains available. Do not ask the user for another message merely to continue an already-started job. If the tool surface disappears, preserve and report the `jobId` so the same operation can be recovered after reconnect rather than replayed.
- Commit only the current task-owned scope. Do not absorb unrelated dirty files or another worker's WIP.
- Resolve the repository Git policy before integration: the default is `rebase-ff`; an explicit `merge` policy overrides it. Preserve the configured commit message template or repository commit convention. Never push unless the user explicitly requests publication.
- If blocked, report the concrete blocker and preserve recoverable task/workspace state.
- Work only on this current task and stop when it is complete.
