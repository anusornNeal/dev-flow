## Execution Rules

- Work in the local repository whenever possible.
- Fetch DevFlow context only when needed, but do not guess task requirements.
- Start repo work with one compact read-only context call, preferably `get_repo_context_bundle` when a project is known.
- Keep every tool payload short, focused, and scoped to the current task.
- Do not repeat the same failed or abnormal tool payload; pause and inspect a small health/status signal before continuing.
- For LLM-authored existing-file changes, prefer Steno Edit as the default path: use `read_file_snippets_batch(includeFileRef=true)` for multiple exact targets, or `read_local_file(includeFileRef=true)` for single-file work; prepare with `prepare_compact_edit`, then apply the returned plan with `apply_prepared_edit`.
- Treat `prepare_compact_edit` as the no-write validation/preview step; apply only the prepared plan id after it succeeds, and re-read/re-prepare stale, expired, or consumed plans instead of replaying them.
- Use `safe_edit_local_file` as the simpler option for a tiny anchored single-file edit, or `edit_local_files_batch` as the guarded fallback when Steno is unsuitable or cannot express the edit safely.
- Use `apply_patch` only for an already-existing or trusted native Git unified diff, a trusted generated diff, or a documented fallback when Steno/structured editing is unsuitable. `*** Begin Patch` / `*** Update File` pseudo-patch syntax is not valid input.
- Prefer smart verification: FAST for the smallest targeted loop, SAFE for broader risk-matched checks, and FULL only for required final/integration gates.
- Use `apply_and_verify` when its supported edit path can safely combine apply, diff capture, and verification; otherwise verify with the smallest relevant `run_project_command`.
- Reuse valid deterministic evidence during iteration, but use `forceFresh` when a final review gate requires fresh proof.
- Commit one small scope before starting the next scope.
- Spawn or split subtasks only when needed, and keep them inside the current card boundary.
- When an async DevFlow tool returns a durable `jobId`, call `get_tool_job_result(jobId, waitMs=30000)` immediately and keep bounded polling in the same assistant turn until terminal whenever the DevFlow tool surface remains available. Do not ask the user for another message merely to continue an already-started job; if the tool surface disappears, preserve and report the `jobId` for recovery after refresh/reconnect.
- If blocked, report the blocker clearly.
- Work only on this current task and stop when it is complete.
