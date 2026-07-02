# DevFlow Authoring Core

## Purpose

Create DevFlow cards that a coding agent can execute safely from DevFlow alone.

A DevFlow card is the source of truth. It must contain the requirement, repo context, implementation scope, acceptance criteria, and verification. The agent must not need to reopen Jira, attachments, comments, screenshots, or external specs to understand the task.

## Non-negotiable rule

Do not write cards that say:

```text
Read Jira before coding.
Open the Jira attachment.
Check Jira comments for details.
See sourceUrl for requirement.
```

Instead, extract the useful information from Jira, attachments, comments, subtasks, and repo inspection, then write that information into the card.

## Required read order

When applicable:

1. For Jira-originated cards, use `get_jira_authoring_bundle` first when available.
2. Read individual Jira issue/comments/subtasks/attachments only when the bundle is unavailable or missing a specific detail.
3. Read attachments if they contain screenshots, videos, logs, designs, wording, or reproduction evidence not already summarized by the bundle.
5. Inspect the repo with `get_repo_context_bundle` first when the project is known.
6. Search for affected screens, strings, APIs, mappers, models, routes, tests, and existing patterns only when the bundle is unavailable or insufficient.
7. Read actual target files, not only search snippets or bundle snippets.
8. Check whether a DevFlow card already exists for the Jira key.
9. Create or update the card only after requirement and repo context are understood.

`get_jira_authoring_bundle` returns the issue, comments, attachment metadata, linked issue hints, and existing DevFlow duplicates in one packet. Use individual Jira proxy tools only when the bundle is missing a specific detail.

## Bounded repo inspection

Repo inspection is required for implementation-ready cards, but it must be targeted.

Use `get_repo_context_bundle` first when a project is known. It should provide the starting git status, repo index matches, focused snippets, and optional diff context in one packet. Query with screen names, visible strings, Jira terms, route names, or flow names.

Use `get_project_atlas` as a companion, not a replacement, when the card is architecture/project-structure/onboarding related, targetFiles remain empty or uncertain after the bundle, the task crosses modules/domains, or the user asks for impact, affected files, module boundaries, or read order.

Fall back to `get_repo_inspection_index`, `search_local_files`, and `read_local_file` only when the bundle is unavailable or does not identify enough target files/functions. Then read only the matched target files that are needed to confirm the implementation map.

Do not scan or read the whole repo. Start from the Jira/user terms and search only for likely screen names, visible strings, route names, ViewModels, composables, fragments, adapters, mappers, APIs, models, and tests. Read only the smallest set of files needed to identify the implementation path.

Atlas guardrails:
- Do not use Atlas to skip reading exact target files before editing or authoring an implementation map.
- Treat verified Atlas facts as stronger than inferred summaries, and label inferred guidance as inferred in `reasoning` or review notes when it matters.
- If Atlas suggests files that conflict with explicit card `targetFiles`, do not override them silently; mention the conflict and inspect the exact files before changing scope.
- Keep lean repo-context workflow for simple single-file cards.

Stop repo inspection when you can name:

- the affected screen or flow,
- the likely target files,
- the exact classes, composables, functions, methods, helpers, routes, mappers, or tests involved,
- the current behavior found in code,
- the smallest safe change location,
- the related tests or verification target,
- files/functions that are explicitly out of scope.

If targeted inspection cannot identify likely files/functions, create a blocked/prep card instead of guessing.

## Local file read/write workflow

Repository edits are a guarded workflow, not a free-form rewrite.

Before reading files:
- Use `get_repo_context_bundle` first when a project is known. Include diff context when current changes may matter.
- Use targeted queries based on task ids, screen names, visible strings, route names, classes, functions, or failing tests.
- Use `read_file_snippets_batch` for several focused ranges, or `read_local_file` for one exact file/range.
- Prefer local reads before remote GitHub/Jira reads unless the user explicitly asks for remote data.

Before writing files:
- Confirm the working tree is clean or understand the existing diff.
- Read the exact target file content or range first; use the returned file revision/hash as a guard when the write tool supports it.
- Choose the lowest-risk write tool:
  - `edit_local_files_batch` for one or more anchored edits; always dry-run first, then apply the same validated intent.
  - `safe_edit_local_file` for a small anchored edit in a large route, contract, service, or generated-looking file.
  - `apply_patch` for compact unified diffs when context is stable; run dry-run/check first.
  - `write_local_file` only for new files, generated files, or small full-file replacements where the complete content is known.
- Do not use full-file writes for large source files when an anchored edit is possible.
- Do not retry the same failed write payload unchanged. Read the error, adjust the anchor/context/tool, then try a new payload.

After writing files:
- Inspect `get_git_diff` or targeted file snippets before claiming the edit is correct.
- Run the most targeted available verification first; run the broader `test`/`verify` preset when the change touches shared workflow, skill, schema, queue, or repository tooling.
- Commit one small scope at a time. Use `commit_git_changes` dry-run before the real commit, stage only the intended files, and never push.
- If a tool returns a `jobId`, poll status/log/result until the final result is known before continuing.

## Implementation map

Every implementation-ready card that came from Jira or a bug report must include an implementation map in `repoContext`.

Format:

```text
Implementation map:
- File: JobDetailScreen.kt
  Class/function: JobDetailContent / DetailsTabContent
  Current behavior: lower tab content does not reserve navigation bar inset.
  Expected change: apply or propagate bottom system-bar padding for the Details tab content.

- File: JobDetailFragment.kt
  Class/function: edge-to-edge or root inset setup
  Current behavior: confirm whether the host consumes navigation bar insets.
  Expected change: adjust only if the screen-level inset owner is here.

Out of scope:
- Do not change unrelated Job Detail tabs, survey submission logic, or other My Jobs screens unless the same inset owner is shared.
```

Keep the map short. Prefer 2-5 target entries. If the exact function is uncertain, say `likely` and explain what must be confirmed first.

Before calling `create_task` or `update_task` for a `todo`, `in-progress`, or `ready-for-review` card, run `validate_task_quality` when available and fix any errors it reports.

## Fallback rules

If Jira cannot be read and the user did not provide enough detail, do not create an implementation-ready card.

If repo cannot be inspected enough to understand implementation context, do not create an implementation-ready card.

Create a blocked/prep card only when the user wants the work preserved but implementation details are missing.

Always be honest about tool failures. Never pretend Jira or repo was read when it was not.

## Deep analysis before writing

Before writing a card, answer these internally:

- What is the user-facing problem?
- What is the current behavior?
- What is the expected behavior?
- What exact behavior changes from what to what?
- What is the smallest safe implementation scope?
- Which screens, files, layers, APIs, models, tests, strings, or flows are involved?
- Which exact classes, composables, functions, methods, helpers, routes, or mappers should the implementer inspect or edit?
- What existing behavior must remain unchanged?
- What is out of scope?
- What tests or manual checks prove completion?
- Is the task too large for one card?
- Are there related Jira issues with the same root cause or implementation?

## Delta rule

Every behavior change must state:

- from what,
- to what,
- where it happens,
- which flow is affected,
- examples that prove the rule,
- out-of-scope boundaries,
- behavior that must remain unchanged.

Bad:

```text
Fix button logic.
```

Good:

```text
Change the Job Detail "เริ่มงาน" button date rule:
- Current wrong behavior: future jobStartDate may enable the button while today/past may disable it.
- Expected behavior: future jobStartDate disables the button; today or past jobStartDate enables it.
- Do not change finish-job or document upload actions.
```

## Wording and copy rule

If the task changes text, include the exact wording in the card.

Include:

- source text,
- target text,
- language,
- screen/location,
- formatting, punctuation, newline, spacing requirements,
- whether to reuse or add string resources.

Do not tell the agent to look up wording in Jira, screenshot, comments, or attachments.

## Duplicate Jira merge rule

Merge multiple Jira issues into one DevFlow card when:

- they have the same root cause,
- they affect the same helper/mapper/component,
- one implementation safely fixes all cases,
- separate cards would duplicate work,
- tests should cover all examples together.

Do not merge when:

- implementation areas differ,
- owners/release timing differ,
- business rules differ,
- testing matrix is too different,
- merge would make the card vague or too large,
- parallel work is safer.

When merging:
- put the primary Jira key first in the title,
- include all relevant Jira keys in title/description,
- use primary key in `jiraKey` if only one value is supported,
- include acceptance criteria for every distinct behavior,
- explain the merge in `reasoning`.

## Subtask-first decomposition rule

Default to splitting work into parent/child cards when the request contains more than one independently verifiable implementation slice. Do not hide real subtask work inside a long checklist.

Before creating one combined card, explicitly check whether separate child cards would be safer. Split when any child can have its own target files, acceptance criteria, verification, branch, owner, or implementation order.

Strong split triggers:
- frontend plus backend/data/API work,
- multiple screens, tabs, routes, or flows,
- shared foundation plus feature slices,
- refactor or migration plus behavior change,
- tests or tooling work that can be verified independently,
- high-conflict files where parallel work would be risky,
- unclear sequencing where a foundation card should define contracts first.

When splitting:
- create a parent orchestration card for requirement, architecture, child boundaries, integration, and final verification,
- create child cards for each narrow implementation slice,
- keep every parent and child in `backlog` by default unless the user explicitly asks to queue/start implementation,
- give each child focused `targetFiles`, its own acceptance criteria, its own verification, and clear out-of-scope boundaries,
- avoid duplicated sibling target files unless unavoidable; explain unavoidable overlap in `reasoning`,
- parent checklist should manage child creation/integration/review; child checklist should contain implementation steps only for that slice.

If tool limits or missing context prevent creating all children immediately, create the parent in `backlog` with a planned child breakdown in `repoContext` and checklist, or return the proposed parent/child set for review. Do not collapse a multi-slice plan into one oversized implementation card just because it is faster.

## Split rule

Split into parent/child cards when work includes:

- multiple screens or flows,
- multiple independent behaviors,
- frontend and backend work that can be separated,
- refactor plus feature/bug fix,
- high merge-conflict risk,
- unclear sequencing or integration risk,
- work that multiple agents can do independently.

Use a parent card for:
- source-of-truth requirement,
- architecture/foundation,
- child boundaries,
- integration points,
- merge/reconcile/final verification.

Use child cards for:
- narrow implementation slices,
- focused target files,
- independent acceptance and verification,
- minimal overlap with sibling files.

Frontend/backend should be split whenever cleanly separable. Use `category: "general"` only when separation is not clean, and explain why in `reasoning`.

## Frontend/backend split rule

Create separate cards when:

- backend API, schema, DTO, mapper, repository, persistence, or data contract work can be changed and verified independently from UI,
- UI can be implemented against an existing, mocked, or clearly defined contract,
- backend behavior can be verified with API/unit/data tests without launching UI,
- frontend and backend work touch different layers, owners, or high-conflict files,
- parallel child work would reduce risk or keep each card focused.

For Android projects:

- `frontend` means Compose, XML, Fragment/Activity hosting, ViewModel UI state, navigation, UI validation, copy, visual state, and screen-level behavior.
- `backend` means API client, DTO/model, mapper, repository, local persistence/cache, feature flags/config, and data/business rule plumbing.
- `general` means parent orchestration, cross-layer integration that cannot be split safely, docs/config, or one tiny atomic change that must edit both sides together.

Use a parent card when one Jira item spans frontend and backend. Parent owns contract, child boundaries, integration risks, and final verification. Child cards must state their boundary and must not duplicate sibling target files unless unavoidable.

Keep one general card only when:

- the change is a small inseparable cross-layer helper,
- the behavior cannot be tested or shipped in frontend/backend slices,
- sequencing requires one atomic commit,
- splitting would create fake boundaries or more risk than clarity.

If keeping one combined card, `reasoning` must say why it was not split and `repoContext` must identify both frontend and backend touch points.

## Branch rule

Normal single-card branches:

```text
fix/qca-3393-start-job-button-date-rule
feature/qca-1234-new-job-filter
chore/qca-1234-refactor-job-detail
```

Orchestrated work:

```text
qca-3400-job-detail-foundation
qca-3400-job-detail-foundation/ui-sticky-tabs
qca-3400-job-detail-foundation/date-rule-tests
```

Parent branch should end with `-foundation`. Child branches should be nested under the parent branch when possible.

## Field placement

### title

For Jira-originated work:

```text
[JIRA-KEY] Verb + object + context
```

For merged Jira work:

```text
[QCA-3393][QCA-3394] Fix start-job date rules on Job Detail
```

### description

Use for product requirement:

- affected screen/flow/module,
- current behavior,
- expected behavior,
- rules/examples,
- exact wording if relevant,
- scope and out-of-scope.

Do not dump Jira metadata such as reporter, assignee, timestamps, sprint, board, or raw priority.

### repoContext

Use for technical findings:

- implementation map with target files and functions/classes,
- likely files/components,
- current implementation behavior,
- existing helpers,
- existing tests,
- architecture patterns,
- related behavior to preserve,
- risks and warnings.

Do not repeat repo URL, local path, or branch metadata.

### checklist

Use concrete executable steps.

Good:

```text
- Confirm the current start-job enablement path used by Job Detail.
- Add regression tests for future/today/past start dates.
- Fix the date comparison so future dates disable the start button.
- Verify existing non-start-job actions are unchanged.
```

Bad:

```text
- Read Jira.
- Understand task.
- Fix bug.
- Test.
```

### acceptanceCriteria

Must be observable pass/fail outcomes.

Avoid implementation-only criteria. Put implementation details in checklist or repoContext.

### verification

Must prove completion with:

- tests to add/update,
- targeted commands when known,
- manual scenarios,
- regression checks,
- device/OS/app version only when relevant.

If exact command is unknown, ask the agent to run the most targeted available test/build command for affected files/classes.

### targetFiles

Keep focused and short. Prefer filenames only unless duplicate names need partial paths.

Target files must align with the implementation map. Do not list broad directories unless the exact file is unknown after targeted inspection.

Do not include README/playbook/root docs unless the task is documentation or agent-config work.

### sourceUrl

Keep empty by default. Use only when stable, accessible, and truly required.

## Status rule

Default card status is `backlog`.

Use:
- `backlog`: default for every newly authored card, draft, parent card, child/subtask card, blocked/prep card, or request phrased as “write/create/update a card”.
- `todo`: only when the user explicitly says the card should be ready for execution, queued, started, assigned for implementation, or moved out of backlog. The card must also pass implementation-ready quality gates.
- `in-progress`: actively being worked.
- `ready-for-review`: implementation finished and needs review.
- `done`: reviewed and accepted.

Do not set `todo` merely because the card is well specified. A card can be implementation-ready and still belong in `backlog` until the user asks to execute it.

## Quality gate

Before creating/updating a card, verify:

- Jira was read or missing Jira is clearly blocked.
- Repo was inspected or missing repo is clearly blocked.
- The card can be implemented without opening Jira.
- Title starts with Jira key for Jira-originated work.
- `jiraKey` is filled when applicable.
- Description contains requirement, not metadata dump.
- Exact required wording is included.
- Similar Jira issues were considered for merge.
- Large work was considered for split.
- Repo context contains useful technical findings and an implementation map when implementation-ready.
- Target files are focused.
- Checklist is concrete.
- Acceptance criteria are pass/fail.
- Verification has concrete tests/scenarios.
- Attachments/comments/subtasks are summarized when relevant.
- Scope is narrow enough to avoid over-fixing.
