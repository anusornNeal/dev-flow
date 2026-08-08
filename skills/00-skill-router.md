# DevFlow Skill Router

## Purpose

Choose the smallest master skill set needed for the current DevFlow action.

## Always prefer lean loading

Do not load all skills by default. Load only the minimal set required by the task.

Master authoring skills are the source of truth. Do not depend on deprecated custom workflow skills when an equivalent master rule exists.

Do not hardcode developer-specific absolute local repo paths in master skills or portable repository metadata. Persist repo-relative paths and resolve the current project/runtime root at execution time.

## When writing or updating a DevFlow card

Load:
- `01-authoring-core.md`
- `02-schema-reference.md`

Also load `03-reviewer-core.md` when the update comes from review feedback, a corrected review assumption, an embedded bug, or a user/product-owner clarification that changes current implementation guidance.

Use:
- `get_jira_authoring_bundle` first for Jira-originated card authoring.
- `get_repo_context_bundle` first when a project is known.
- `get_project_atlas` only as a companion for architecture, project structure, onboarding, module boundaries, cross-module impact, read order, or uncertain target files.
- Targeted task, git, search, and file reads when the composite bundle is unavailable or insufficient.
- The `Clarification gate for non-trivial cards` from Authoring Core before creating or substantially rewriting a large or materially ambiguous implementation card.
- The `Figma evidence rule for frontend cards` from Authoring Core whenever a frontend card has a Figma source.
- `validate_task_quality` before `create_task` or `update_task` for any implementation-ready card.

Do not require Project Atlas for simple single-file or clearly targeted cards.

## When scanning or authoring Project Atlas

Load:
- `01-authoring-core.md`

Use the `ChatGPT-authored Project Atlas scan` workflow in Authoring Core.

Use:
- `get_repo_context_bundle` first when the project is known.
- staged local reads for repo identity, directory inventory, runtime entrypoints, feature anchors, repository/model coverage, and tests.
- `apply_project_atlas_agent_update` to save the final Atlas.
- `get_project_atlas_status` to verify freshness and counts.

Do not load schema/examples unless writing or updating a card. Do not create every-file graph nodes unless explicitly requested.

## When opening or correcting a bug on an existing task

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
- Read existing edit targets with `read_local_file(includeFileRef=true)` when available.
- Prefer Steno Edit: `prepare_compact_edit` is the no-write preview and `apply_prepared_edit` applies only the returned plan id. Re-read and re-prepare stale, expired, or consumed plans.
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
