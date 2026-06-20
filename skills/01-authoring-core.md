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
5. Inspect the repo.
6. Search for affected screens, strings, APIs, mappers, models, routes, tests, and existing patterns.
7. Read actual target files, not only search snippets.
8. Check whether a DevFlow card already exists for the Jira key.
9. Create or update the card only after requirement and repo context are understood.

`get_jira_authoring_bundle` returns the issue, comments, attachment metadata, linked issue hints, and existing DevFlow duplicates in one packet. Use individual Jira proxy tools only when the bundle is missing a specific detail.

## Bounded repo inspection

Repo inspection is required for implementation-ready cards, but it must be targeted.

Use `get_repo_inspection_index` first when available. Query with screen names, visible strings, Jira terms, route names, or flow names. Then read only the matched target files that are needed to confirm the implementation map.

Do not scan or read the whole repo. Start from the Jira/user terms and search only for likely screen names, visible strings, route names, ViewModels, composables, fragments, adapters, mappers, APIs, models, and tests. Read only the smallest set of files needed to identify the implementation path.

Stop repo inspection when you can name:

- the affected screen or flow,
- the likely target files,
- the exact classes, composables, functions, methods, helpers, routes, mappers, or tests involved,
- the current behavior found in code,
- the smallest safe change location,
- the related tests or verification target,
- files/functions that are explicitly out of scope.

If targeted inspection cannot identify likely files/functions, create a blocked/prep card instead of guessing.

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

- `backlog`: requirement needs review, blocked/prep, or user only asked to create a card.
- `todo`: implementation-ready and user clearly wants it ready for execution.
- `in-progress`: actively being worked.
- `ready-for-review`: implementation finished and needs review.
- `done`: reviewed and accepted.

If the user only says “write a card”, prefer `backlog` unless they clearly want execution-ready work.

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
