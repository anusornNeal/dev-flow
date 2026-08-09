# DevFlow Schema Semantic Reference

## Purpose
Use this only when the live task/tool schema does not answer a semantic placement question. The live task schema (`get_schema`) and exact MCP tool schema (`get_tool_schema`) are authoritative for field types, enums, required fields, aliases, and nested JSON shapes. Do not duplicate those lists here.

## Authoring helper tools
- `get_schema`: authoritative task field shape.
- `get_tool_schema`: authoritative input/output shape for one MCP tool.
- `get_capabilities`: current exposed capability/catalog information.

If this file conflicts with a live schema, follow the live schema and fix this guidance.

## Semantic field placement
### `description`
State the requested behavior and scope delta. Keep implementation archaeology out unless it changes product behavior.
- `get_jira_authoring_bundle`: bounded Jira evidence packet; use before individual Jira proxy reads.
- `get_repo_context_bundle`: preferred first repo packet; use `get_project_atlas` for cross-module/read-order hints and `get_repo_inspection_index` only as a targeted fallback.
- `read_file_snippets_batch(includeFileRef=true)` / `read_local_file(includeFileRef=true)`: bounded Steno bootstrap for multi-file / single-file work.
- `prepare_compact_edit` + `apply_prepared_edit`: default for LLM-authored existing-file changes when revision-bound anchored edits fit; preview first and re-read/re-prepare stale plans.
- `safe_edit_local_file`: simpler tiny anchored single-file edit. `edit_local_files_batch`: guarded structured fallback.
- `apply_patch`: exception for an existing/trusted native Git unified diff or documented fallback. `*** Begin Patch` / `*** Update File` is invalid input.
- `write_local_file`: new files or small known full-file replacements only.
- `apply_and_verify` / `run_project_command`: risk-matched verification; use fresh final evidence when required.
- `commit_git_changes`: commit only the intended verified scope; never push by default.
- `validate_task_quality`: optional preflight for server-enforced authoring quality. `open_task_bug`: keep defects inside an existing task instead of creating a new card.
- `devflow_health_check`: compact readiness diagnostics. `move_task_to_status`: follow allowed status paths.

### `repoContext`
Put repository evidence and implementation guidance here. Implementation-ready work should normally contain:

`Implementation map:\n- File: <repo-relative path>\n  Class/function: <symbol>\n  Current behavior: <evidence>\n  Expected change: <delta>`

Use repo-relative paths. Do not persist machine-specific absolute paths.

### `targetFiles`
List focused repo-relative files supported by the implementation map. Do not use it as a speculative directory dump.

### `checklist`
Use for milestones inside one implementation boundary. If entries are independently implementable/reviewable, use child cards instead.

### `acceptanceCriteria`
Describe observable pass/fail outcomes, including important negative or edge behavior.

### `verification`
Name concrete automated/manual evidence and the smallest useful test scope. Final fresh gates remain available when required.

### `parentId`
Use only for a real parent/child implementation relationship, not loose topical grouping.

### source/design fields
Use Jira/Figma/source identifiers as provenance; summarize the implementation-relevant evidence in `repoContext`. Load `05-authoring-evidence` for source-specific rules.

## Status semantics
Default newly authored cards to `backlog` unless the user/workflow explicitly queues or starts the work. Do not infer `todo` from implementation readiness alone.

## Mutation semantics
Create/update mutations enforce the authoritative server-side quality gate. A separate `validate_task_quality` call is optional diagnostic/preflight behavior, not a required duplicate payload round trip.

## Execution references
When implementation follows immediately, load `07-authoring-execution`. It covers `read_file_snippets_batch(includeFileRef=true)`, guarded edits, `write_local_file`, verification, and `commit_git_changes` without duplicating their schemas here.
