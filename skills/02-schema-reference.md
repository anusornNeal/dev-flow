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
- `get_jira_authoring_bundle`: one-call Jira packet for issue summary, description, comments, attachment metadata, related issues, and existing DevFlow duplicate cards. Use it before individual Jira proxy tools.
- `get_repo_context_bundle`: one-call repo packet for project metadata, git status, repo index matches, focused file snippets, and optional diff context. Prefer this first when a project is known.
- `get_project_atlas`: compact project knowledge graph for architecture, onboarding, unclear targetFiles, cross-module impact, module boundaries, and read order. Use modes `compact`, `standard`, `agent-context`, `chatgpt-context`, `task-focused`, or `diff-impact`; keep it companion-only after `get_repo_context_bundle`, and never let stale/noisy/inferred Atlas summaries silently override explicit targetFiles or exact local reads.
- `get_repo_inspection_index`: cached repo index for likely files, classes, composables, functions, routes, mappers, helpers, and tests. Use it as a targeted fallback when the repo context bundle is unavailable or insufficient.
- `read_file_snippets_batch(includeFileRef=true)`: preferred multi-file Steno bootstrap after the bundle/index identifies exact targets; returns bounded snippets plus revision-bound refs in one round trip, with optional aggregate byte limits and partial per-file errors.
- `read_local_file`: read one exact local file or line range before editing; request `includeFileRef=true` for genuinely single-file Steno work.
- `prepare_compact_edit` + `apply_prepared_edit`: default compact edit flow for LLM-authored existing-file changes when revision-bound anchored edits are available. Preparation is the no-write preview; apply only the returned plan id and re-read/re-prepare stale plans.
- `apply_and_verify`: composite fast path for supported prepared/structured edits when mutation, diff capture, and risk-aware verification can safely run together.
- `safe_edit_local_file`: explicitly allowed simpler path for a tiny anchored single-file edit when Steno is unnecessary; prefer it over full-file writes for route, contract, and service files.
- `edit_local_files_batch`: guarded multi-file anchored fallback. Dry-run first, then apply after the preview matches intent.
- `apply_patch`: exception for an already-existing or trusted native Git unified diff, a trusted generated native Git unified diff, or a documented fallback when structured/Steno editing is unsuitable. `*** Begin Patch` / `*** Update File` pseudo-patch syntax is not valid input. Use dry-run/check before apply.
- `write_local_file`: create new files or perform small full-file replacements only when complete content is known. Avoid it for large source files when anchored edits are possible.
- `run_project_command`: run allowlisted verification presets after local edits. Prefer the smallest risk-matched FAST/SAFE evidence; use FULL for required final integration/review gates and `forceFresh` when fresh evidence is required.
- `commit_git_changes`: commit one small verified scope. Use dry-run first and stage only intended files. Never push.
- `validate_task_quality`: preflight the card before `create_task` or `update_task`. It blocks implementation-ready cards that still depend on Jira/source links, lack focused `targetFiles`, or lack an `Implementation map` in `repoContext`.
- `open_task_bug`: create an embedded bug thread under an existing task for defect feedback, review failures, or user reports like “เปิดบัค”. Use this instead of `create_task` when the work belongs to an existing card.
- `devflow_health_check`: read-only workflow readiness check for git cleanliness, tool capability counts, queue diagnostics, and recommendations.
- `move_task_to_status`: move a card to a target lane by following allowed transition paths automatically. Prefer it over repeated manual `move_task_status` calls when closing or reopening a card.

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
