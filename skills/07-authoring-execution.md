# DevFlow Authoring Execution Specialist

## Purpose
Load only when card authoring continues into repository implementation, guarded edits, verification, or commit work.

## Local file read/write workflow
Start with `get_repo_context_bundle` for the current project and requirement. Read only the exact files/symbols needed for the change.

For multiple edit targets, prefer `read_file_snippets_batch(includeFileRef=true)` so bounded content, revisions, and Steno-ready refs arrive together. For a genuinely single-file target, use `read_local_file(includeFileRef=true)`.

Keep repository paths relative in portable metadata. Let DevFlow resolve the active root/workspace internally.

## Guarded edits
Prefer preview before mutation.
- For LLM-authored existing-file changes, default to `prepare_compact_edit` + `apply_prepared_edit` when revision-bound anchored edits are available; do not synthesize native unified diffs when Steno or a structured anchored edit expresses the change safely.
- Apply an unchanged Steno preview with `apply_prepared_edit` using only the returned plan id.
- Use `edit_local_files_batch` as the guarded structured fallback for tiny anchored edits or trusted diff content that must be translated into revision-guarded operations.
- Use `apply_and_verify` when the supported edit path can safely combine mutation, diff capture, and risk-aware verification.

Revision/hash guards must remain authoritative. If a target changes, re-read and re-prepare rather than forcing a stale edit.

Do not retry the same failed write payload unchanged. Inspect the failure and change the payload, anchor, target, identifier, or tool strategy first.

## Smart verification
Use the smallest risk-appropriate lane while implementing:
- **FAST** — focused deterministic checks for low-risk/local changes.
- **SAFE** — broader targeted checks for shared behavior, contracts, or higher-risk changes.
- **FULL** — repository-wide milestone/final verification when policy or risk requires it.

Do not remove checks solely to improve timing. Preserve safe parallelism and semantic deduplication where available. Use `forceFresh` when final evidence must not reuse cached command results.

## Verification evidence
Record the command/check, pass/fail result, and what behavior it proves. A cached warm result is useful during iteration, but a required final fresh gate remains authoritative.

## Commit workflow
Before committing:
- inspect `get_git_status` / diff for unrelated changes;
- never stage another session's work;
- when an execution session owns the task scope, call `plan_task_commit` first and prefer `commit_task_owned_changes` so only execution-owned files are staged;
- for task-aware commits, pass conventional `<type>[(scope)]: <description>` input. DevFlow's default renders `[<cardId>] <type>: <description>` from the authoritative task/Jira id; explicit project templates override the default, so do not manually duplicate the prefix;
- preserve unrelated dirty files exactly as reported by the task-aware plan;
- use an explicit file list when task-aware execution ownership is unavailable and concurrent chats may share the base repo;
- dry-run `commit_git_changes` before a fallback low-level commit when practical.

Create small scope-aligned local commits. Resolve the repository Git policy before integration: the default policy is `rebase-ff`, while an explicit project policy may require `merge`; follow the policy rather than assuming topology from branch names. Preserve the configured commit message template or existing repository commit convention when creating commits, and let `integrate_workspace` enforce the resolved policy instead of hand-rolling integration. Do not push unless the user explicitly requests it.

## Multi-session safety
If another session modifies one of the same target files, stop before mutation and re-resolve ownership/workspace state. Independent files may proceed with revision guards and explicit-file commits.
