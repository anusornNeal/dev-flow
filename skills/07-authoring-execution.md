# DevFlow Authoring Execution Specialist

## Purpose
Load this skill when a DevFlow card continues into repository implementation, test-first work, guarded edits, verification, task-owned commit, managed workspace lifecycle, or recovery.

## Task ownership and managed workspace
Before mutating an existing DevFlow task, establish authoritative ownership. Reuse the task claim already owned by this session or call `claim_task` for the named task. Use only the managed workspace returned by DevFlow.

Do not create or switch to a replacement workspace to bypass a claim, scope conflict, or ownership error. If another session owns the task or overlapping files, stop mutation and resolve ownership first.

## Local file read/write workflow
Start with `get_repo_context_bundle` for the current requirement and workspace. Read only exact files and symbols needed for the change.

For multiple edit targets, prefer `read_file_snippets_batch(includeFileRef=true)` so bounded content, revisions, and edit-ready refs arrive together. For a genuinely single-file target, use `read_local_file(includeFileRef=true)`.

Keep portable metadata repository-relative. Never derive or persist the physical managed-workspace path.

## Guarded edits
Preview before mutation when practical.
- For LLM-authored existing-file changes, prefer `prepare_compact_edit` followed by `apply_prepared_edit` when revision-bound anchored edits fit.
- Apply only the returned prepared plan. If source changes or a plan expires/is consumed, re-read and re-prepare instead of replaying it.
- Use `edit_local_files_batch` as the guarded structured fallback when compact edits are unsuitable.
- Use `write_local_file` for new files or intentional full-file replacements when that is clearer and bounded.
- Use `apply_and_verify` when its supported edit path can safely combine mutation, diff capture, and risk-aware verification.

Revision and hash guards are authoritative. Do not retry the same failed write payload unchanged; inspect the error and change the source revision, anchor, target, payload, or tool strategy.

## Test-first implementation
For behavior changes and bug fixes, author focused tests before implementation when the repository and task make automated regression proof practical. Run a focused RED check when the failure is meaningful or repository/task TDD policy requires it, then implement the smallest change that reaches GREEN.

Strict repository or task TDD policy overrides lighter defaults. Regardless of whether RED execution is practical, focused GREEN evidence for changed behavior is required before commit unless the task explicitly defines a different proof method.

## Smart verification
Use the smallest risk-appropriate verification lane while iterating:
- **FAST** — focused deterministic checks for low-risk local changes.
- **SAFE** — broader targeted checks for shared contracts, cross-file behavior, or higher-risk changes.
- **FULL** — repository-wide or milestone verification when project policy, risk, or final integration requires it.

Do not delete meaningful checks merely to reduce runtime. Record what each check proves. Reuse valid deterministic evidence during iteration only when freshness rules allow it; use fresh final evidence when the closing gate requires it.

## Async tool completion
When an async DevFlow operation returns a durable job id, call `get_tool_job_result` with a bounded wait and continue polling in the same assistant turn until terminal while the tool surface remains available. If connectivity disappears, preserve the job id and recover it after reconnect rather than replaying the mutation.

## Task-owned commit
Before committing:
- inspect `get_git_status` and the relevant diff;
- never stage another session's work;
- call `plan_task_commit` for execution-owned scope;
- prefer `commit_task_owned_changes` so only files owned by this task/session are committed;
- preserve unrelated dirty files exactly as reported by the plan.

Use a conventional commit input and let DevFlow apply the authoritative task/ticket prefix and project commit policy. Resolve the repository Git policy before terminal integration: the default is `rebase-ff`; an explicit `merge` policy overrides it. Preserve the configured commit message template or repository commit convention.

Do not push unless the user explicitly requests publication.

## Preferred terminal path
After the claimed workspace is clean, committed, and required checks pass, prefer `finalize_task_workspace` as the normal local terminal flow. It owns repository-policy integration, evidence synchronization, task completion, and safe workspace cleanup when eligible.

If finalization reports `needs-recovery` or cannot prove a safe terminal state, preserve the workspace and inspect it with `inspect_workspace_recovery`. Do not force-clean ambiguous work.

`integrate_workspace` is a recovery fallback, not the normal terminal path for an eligible task finalization. Use the recorded conflict/retry/abort recovery primitives only after inspecting the workspace state, and never overwrite unrelated base work to make integration succeed.

## Multi-session safety
Independent tasks may proceed in parallel when ownership and target scope are disjoint. If another session begins modifying the same target files, stop before further mutation and re-resolve task/workspace ownership. Never reset, delete, or absorb another session's WIP without explicit recovery authority.
