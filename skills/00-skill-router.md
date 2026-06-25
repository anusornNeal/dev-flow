# DevFlow Skill Router

## Purpose

Choose the smallest skill set needed for the current DevFlow action.

## Always prefer lean loading

Do not load all skills by default. Load only the minimal set required by the task.

## When writing or updating a DevFlow card

Load:
- `01-authoring-core.md`
- `02-schema-reference.md`

Use:
- `get_jira_authoring_bundle` first for Jira-originated card authoring.
- `get_repo_context_bundle` first when a project is known; use it as the compact entry point for git status, repo index, snippets, and diff context.
- `get_repo_inspection_index`, `read_local_file`, or search tools only when the repo context bundle is unavailable or insufficient.
- `validate_task_quality` before `create_task` or `update_task` for any implementation-ready card.

## When doing repository or local file edits

Load:
- `01-authoring-core.md`
- `02-schema-reference.md`

Use:
- `get_repo_context_bundle` first when a project is known.
- `read_local_file` or `read_file_snippets_batch` before writing any existing file.
- `edit_local_files_batch` or `safe_edit_local_file` for anchored edits, with dry-run before apply.
- `write_local_file` only for new files or small full-file replacements where the complete content is known.
- `apply_patch` only for compact unified diffs with stable context, with dry-run before apply.
- `run_project_command` after edits, then `commit_git_changes` dry-run before the real commit.

Do not retry the same failed write payload unchanged. Inspect the error and change the payload, tool, or target context first.

Load `04-examples.md` only if:
- the requested output must be full JSON,
- the agent is likely to violate schema,
- parent/child structure is complex,
- a concrete sample is needed.

## When reviewing a ready-for-review card

Load:
- `03-reviewer-core.md`
- `02-schema-reference.md`

Do not load authoring examples unless the review requires rewriting the card.

## When only explaining card quality

Load:
- `01-authoring-core.md`

Do not load schema/examples unless field-level validation is needed.

## When only validating JSON fields

Load:
- `02-schema-reference.md`

## General rule

Core skills define behavior. Examples are optional reference material.
