# DevFlow Skill Router

## Purpose
Choose the smallest guidance set required for the current DevFlow action. Do not load every authoring skill by default.

## Common card authoring
For a normal non-Jira, non-Figma card with clear scope:
- load `01-authoring-core` only;
- call `get_repo_context_bundle` first when a project is known;
- use targeted reads only when the bundle is insufficient;
- use the live task/MCP schema for field types and enums;
- do not load `02-schema-reference` unless field placement is genuinely unclear.

A common authoring flow should normally fit in 2–4 meaningful calls: lean guidance, bounded repo evidence, then create/update (plus one focused read only if required).

## Source-specific evidence
Load `05-authoring-evidence` only when the card depends on Jira, Figma, Project Atlas, or another source that needs special evidence handling.
- Jira: use `get_jira_authoring_bundle` first.
- Figma: preserve exact file/node evidence.
- Atlas: use only for architecture, module boundaries, uncertain targets, cross-module impact, or read order.
Do not require Project Atlas for simple single-file or clearly targeted cards.

## Decomposition
Load `06-authoring-decomposition` only for large work, parent/child authoring, frontend/backend splits, or when a checklist is starting to hide independent implementation units.

## Repository implementation/editing
Load `07-authoring-execution` only when the current action includes local code/file edits, verification, or commit work. Multi-file edits should bootstrap with `read_file_snippets_batch(includeFileRef=true)`; a genuinely single-file edit may use `read_local_file(includeFileRef=true)`.

## Continuous board execution
Load `08-board-loop-execution` for board-loop / keep-taking-work requests. It requires atomic `claim_task` ownership so concurrent chats skip duplicate or overlapping work.

## Review and existing-task defects
Load `03-reviewer-core` for review, review feedback, corrected review assumptions, and embedded bug guidance. Use `open_task_bug` for a distinct defect on an existing task; do not create a new top-level task unless the user explicitly requests one.

## Schema-only questions
Prefer exact MCP schemas via `get_tool_schema`, especially the `create_task` and `update_task` schemas for task fields. Load `02-schema-reference` only for semantic placement that schemas cannot express, such as what belongs in `repoContext` versus `description`.

## Examples
Load `04-examples` only when a concrete sample, complex task patch, or parent/child example is useful.

## General rules
- Master skills define behavior; examples are reference material.
- Keep portable metadata repo-relative. Never hardcode developer-specific absolute local repo paths.
- Do not retry the same failed payload unchanged; change the strategy, payload, identifier, or evidence first.
- Server-side mutation validation is authoritative. Explicit preflight validation is optional diagnostic/preview guidance, not a mandatory duplicate round trip.

Load:
- `01-authoring-core.md`
- `02-schema-reference.md`
- `03-reviewer-core.md`
Use `open_task_bug` when the user reports a distinct defect on an existing task or a review fails for a new root cause. Do not use `create_task` unless a separate card is explicitly requested.

Before opening another bug:
- inspect existing bug threads,
- update or reopen the same-root-cause thread when possible,
- archive invalid assumptions,
- archive or supersede obsolete guidance,
- keep only one current implementation-guidance bug open for the same defect set.

When the user corrects a reviewer assumption, treat the latest clarification as higher-priority evidence, re-read the affected code/design/project pattern, and replace contradictory guidance instead of stacking another conflicting bug.

## When doing repository or local file edits

Load:
- `01-authoring-core.md`
- `02-schema-reference.md`

Use:
- `get_repo_context_bundle` first when a project is known.
- `get_project_atlas` only for architecture/project-map, onboarding, unclear target files, cross-module impact, module boundaries, or read order.
- For multi-file edits, read exact targets with `read_file_snippets_batch(includeFileRef=true)` so snippets, revisions, and Steno-ready refs arrive in one bounded call; use `read_local_file(includeFileRef=true)` for genuinely single-file work.
- For LLM-authored existing-file changes, prefer Steno Edit by default: `prepare_compact_edit` is the no-write preview and `apply_prepared_edit` applies only the returned plan id. Re-read and re-prepare stale, expired, or consumed plans.
- Use `edit_local_files_batch` as the guarded structured fallback when Steno is unsuitable, including when a trusted native Git unified diff must be translated into revision-guarded anchored operations.
- Use `apply_and_verify` when its supported prepared/structured edit path can safely combine mutation, diff capture, and risk-aware verification.
- Otherwise run the smallest targeted `run_project_command`; use `forceFresh` when final evidence must not be reused.
- `commit_git_changes` dry-run before the real commit.

Do not retry the same failed payload unchanged. Inspect the error and change the payload, tool, identifier, or target context first.

Load `04-examples.md` only when:
- full JSON output is required,
- schema violations are likely,
- parent/child structure is complex,
- a concrete sample is needed.

## When reviewing a ready-for-review card

Load:
- `03-reviewer-core.md`
- `02-schema-reference.md`

Also load `01-authoring-core.md` when review may rewrite card scope, acceptance criteria, repo context, checklist, or embedded bug guidance.

A valid review must inspect the task, parent/children, embedded bugs, branch or integrated commit, diff, changed files, nearest project patterns, tests, and relevant Jira/Figma evidence.

For API wrappers, async helpers, optimistic/loading state, retries, error routing, lifecycle changes, or shared base changes, review all meaningful terminal paths defined in Reviewer Core—not only success and one local-error case.

## When only explaining card quality

Load:
- `01-authoring-core.md`

Load `03-reviewer-core.md` too when the explanation concerns review evidence, invalid bugs, supersession, terminal error paths, or pass/fail status.

## When only validating JSON fields

Load:
- `02-schema-reference.md`

## General rule

Master core skills define behavior. Examples are optional reference material. Deprecated custom workflow skills must not override the master router, authoring core, schema reference, or reviewer core.