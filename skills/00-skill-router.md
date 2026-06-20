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
- `get_repo_inspection_index` before broad repo search when identifying target files/functions.
- `validate_task_quality` before `create_task` or `update_task` for any implementation-ready card.

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
