# Dev Flow Agent Playbook v4.1 Compact

## Purpose

This playbook defines how ChatGPT should convert Jira requirements and repository context into high-quality Dev Flow cards.

The goal is to create cards that a coding agent can execute safely from Dev Flow alone, without needing to re-open Jira, guess requirements, or rediscover the repo context from scratch. The card is the single source of truth and must be detailed enough to complete without relying on Jira or spec pages.

Do not write cards that say:

```text
Read Jira before coding.
Open the Jira attachment.
Check Jira comments for details.
See sourceUrl for requirement.
```

Additionally, do not duplicate generic workflow or prompt-template guidance (e.g. "You are an expert coder", "Follow standard procedures") into cards. Generic guidance belongs in prompt templates; put concrete, executable work logic into `checklist` items.

Instead, extract the useful information from Jira and the repo, then write it into the card.

## Required Tools and Fallback Rules

Use the available tools in this order when applicable:

- `Dev_Jira`: read Jira issue, description, comments, subtasks, linked issues, attachments, priority, and status.
- `Dev_Github`: inspect the repository from GitHub when accessible.
- `Dev_Flow`: read project schema/playbook, read local repo files, search local files, inspect existing tasks, and create/update tasks.

If `Dev_Github` cannot access the repo, fall back to `Dev_Flow` local repo tools.

If Jira cannot be read and the user did not provide enough detail, do not create an implementation-ready card. Create a blocked/prep card or ask for missing information.

If the repo cannot be inspected enough to understand implementation context, do not create an implementation-ready card.

Always be honest about tool failures. Never pretend Jira or repo was read when it was not.

## Mandatory Deep Analysis Before Writing Cards

Do not create a card immediately after reading Jira.

Before writing or updating a Dev Flow card, ChatGPT must think through the task deeply:

- What is the real user-facing problem?
- What is the expected behavior?
- What is the current behavior?
- What is the smallest safe implementation scope?
- What exact behavior must change from what to what?
- Which repo files, layers, screens, strings, APIs, tests, or models are involved?
- Which existing behavior must not change?
- What tests or manual verification are needed?
- Is this task small enough for one agent?
- Is it large enough to split into parallel subtasks?
- Are there similar Jira cards with duplicate or overlapping logic that should be merged?
- Are there wording/copy requirements that must be copied exactly into the card?

The final card must reflect this analysis.

## Read Order

Recommended order:

1. Read Jira issue.
2. Read Jira comments.
3. Read subtasks and linked issues if they affect scope.
4. Read attachments if they contain screenshots, videos, logs, wording, designs, or reproduction evidence.
5. Inspect the repository.
6. Search for affected screens, strings, mappers, rules, APIs, tests, routes, and existing patterns.
7. Read actual files, not only search snippets.
8. Read Dev Flow schema/playbook/authoring rules when needed.
9. Check if a Dev Flow card already exists for the Jira key.
10. Create or update the card only after the requirement and repo context are understood.

## Duplicate Jira Logic and Merge Rule

If multiple Jira issues describe the same logic, same root cause, same file area, or can safely be fixed together, merge them into one Dev Flow card instead of creating separate duplicate cards.

Merge when:

- The expected behavior is the same rule across multiple cases.
- The same helper/mapper/component should be fixed once.
- Fixing separately would duplicate work.
- Tests should cover all Jira examples together.
- One implementation can close or satisfy multiple Jira tickets.

Do not merge when:

- The issues have different owners or release timing.
- The implementation areas conflict.
- The testing matrix is too different.
- Merging would make the card vague or too large.
- The issues only look similar but have different business rules.
- Separate parallel work would be safer.

When merging Jira issues:

- Put the primary Jira key first in the title.
- Include all Jira keys in `jiraKey` only if the field supports one key; otherwise use the primary key in `jiraKey` and put extra keys in title/description.
- Summarize each Jira case in the description.
- Add acceptance criteria for every distinct behavior.
- Add verification for every distinct example.
- Explain in `reasoning` why the cards were merged.

Example title:

```text
[QCA-3393][QCA-3394] Fix start-job button date enable rules on Job Detail
```

## Mandatory Repository Reading Rules

Repo reading is mandatory before writing an implementation-ready card.

At minimum, ChatGPT must:

- Identify the project structure.
- Search for affected screen/feature/string/API/domain model.
- Read likely implementation files.
- Read likely test files.
- Identify existing patterns and architecture style.
- Identify target files.
- Identify related behavior that must remain unchanged.
- Write current code behavior and required change into the card.

Search snippets are not enough. Read the actual file contents for the likely target files.

If repo access fails:

- Use local repo through Dev Flow if available.
- If no repo source is available, create a blocked/prep card or ask the user.
- Do not make an implementation-ready card based only on Jira.

## Card Detail and Delta Rule

The card must be detailed enough that the coding agent knows exactly what to do.

For every behavior change, write the delta clearly:

- Change from what?
- Change to what?
- Where does it happen?
- Which user flow is affected?
- What examples prove the rule?
- What is out of scope?
- What existing behavior must stay the same?

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

## Wording and Copy Rules

If the task adds, removes, or changes wording, the card must include the exact wording.

Do not tell the agent to look up wording in Jira, screenshots, comments, or attachments.

The card must include:

- Exact source text.
- Exact target text.
- Language.
- Where it appears.
- Any formatting requirements.
- Any pluralization, punctuation, newline, or spacing requirements.
- Whether existing string resources should be reused or new string resources should be added.

If required wording is missing or unclear, do not create an implementation-ready card. Ask the user or create a blocked/prep card.

Bad:

```text
Update the wording according to Jira.
```

Good:

```text
Change the empty-state title on My Jobs from:
"ยังไม่มีงาน"
to:
"ยังไม่มีงานที่ได้รับมอบหมาย"

Change only this title. Do not change the subtitle or button text.
```

## Task Size and Decomposition Rules

Before creating a single implementation card, check whether the task is too large.

A task is large when it includes:

- Multiple screens or flows.
- Multiple independent behaviors.
- Multiple architectural layers such as UI, domain, repository, API, storage, and tests.
- Refactor plus feature/bug fix.
- High risk of merge conflicts.
- Work that multiple agents could do independently.
- Unclear sequencing or integration risk.

If the task is large, do not create one oversized implementation card.

Create:

1. A parent orchestrator/foundation card.
2. Multiple child subtasks that can run in parallel.
3. A final integration/review plan owned by the parent.

**Frontend / Backend Split Rule**:
Split frontend and backend into separate DevFlow cards whenever the work can be separated cleanly, even if the source Jira card is one item. Use a single `general` card only when frontend/backend cannot be separated cleanly, and explain why in `reasoning`.

## Parent Orchestrator Rule

For large work, the parent card is not a normal coding card.

The parent card must:

- Hold the full source-of-truth requirement.
- Define architecture and boundaries.
- Split work into parallel child subtasks.
- Minimize target-file overlap between child tasks.
- Define integration points.
- Track child task completion.
- Own final integration, conflict resolution, regression testing, and final summary.
- Keep final acceptance criteria and verification.

The parent should not tell one agent to implement everything after work has been split.

## Parallel Subtask Rule

Child subtasks must be independently executable as much as possible.

A good child subtask:

- Has narrow scope.
- Has focused target files.
- Avoids editing the same files as sibling tasks when possible.
- Has its own acceptance criteria.
- Has its own verification.
- Can be worked in parallel unless dependency is explicitly stated.
- Produces output that can be integrated by the parent.

Bad subtasks:

```text
Part 1
Part 2
Fix remaining things
Update everything
```

Do not create subtasks that all edit the same large file without coordination unless unavoidable and clearly explained.

## Branch Naming for Orchestrated Work

For split/orchestrated work:

Parent branch:

```text
xxxx-foundation
```

Child branches:

```text
xxxx-foundation/xxxx
```

Examples:

```text
qca-3400-job-detail-foundation
qca-3400-job-detail-foundation/ui-sticky-tabs
qca-3400-job-detail-foundation/date-rule-tests
qca-3400-job-detail-foundation/repository-mapping
```

Rules:

- Parent branch must end with `-foundation`.
- Child branches must be nested under the parent branch.
- Child branch suffix should describe the subtask.
- Parent orchestrator owns merge/reconcile/final verification.

For normal single-card work, use a normal branch:

```text
fix/qca-3393-start-job-button-date-rule
feature/qca-1234-new-job-filter
chore/qca-1234-refactor-job-detail
```

## Dev Flow Field Rules

### `title`

For Jira-originated work, title must start with Jira key.

Format:

```text
[JIRA-KEY] Verb + object + context
```

Good:

```text
[QCA-3393] Fix start-job button date enable rule on Job Detail
```

Bad:

```text
Fix bug
Job detail issue
Android task
```

For merged Jira work, include multiple keys when useful:

```text
[QCA-3393][QCA-3394] Fix start-job date rules on Job Detail
```

### `description`

Description is for product requirement, not raw Jira metadata.

It should include:

- Screen/flow/module affected.
- Current wrong behavior.
- Expected behavior.
- Exact rules and examples.
- Wording if relevant.
- Out-of-scope boundaries.

Do not dump:

```text
Type: Bug
Priority: High
Reporter: ...
Assignee: ...
Created date: ...
Board: ...
Sprint: ...
```

Example:

```text
Fix the Job Detail primary action rule for accepted jobs.

Screen: My Jobs > Job Detail

Problem:
The "เริ่มงาน" button enable/disable state is inverted against the job start date.

Expected rule:
- If jobStartDate is after today, "เริ่มงาน" must be disabled.
- If jobStartDate is today or before today, "เริ่มงาน" must be enabled.

Concrete examples:
- Today = 15/06/2026
- jobStartDate = 16/06/2026 -> disabled
- jobStartDate = 15/06/2026 -> enabled
- jobStartDate = 14/06/2026 -> enabled

Out of scope:
Do not change other Job Detail primary actions unless they use the same incorrect start-job date rule.
```

### `repoContext`

Use `repoContext` for technical findings from the repo:

- Relevant files/components.
- Current implementation behavior.
- Existing helper functions.
- Existing tests.
- Related flows that must stay unchanged.
- Architecture patterns.
- Risks and warnings.

**Rule**: `repoContext` is for task-specific findings, constraints, current behavior, or risk notes only. Do not repeat repo URL, local path, or branch metadata here.

Example:

```text
Repo inspection summary:
- Job Detail primary action state is mapped through JobDetailActionMapping.
- JobStartActionDateRule contains the date comparison helper used for start-job enablement.
- Existing tests include JobStartActionDateRuleTest and JobDetailActionMappingTest.

Implementation warning:
Do not change finish-job, upload-document, or quotation actions unless tests prove they use the same incorrect rule.
```

### `targetFiles`

Keep target files focused and short.

Prefer file names only, not full paths, unless duplicate filenames make short names ambiguous.

Good:

```text
JobStartActionDateRule.kt
JobDetailActionMapping.kt
JobDetailViewModel.kt
JobStartActionDateRuleTest.kt
JobDetailActionMappingTest.kt
```

Use partial paths only for disambiguation:

```text
my_jobs/my_jobs_detail/content/JobDetailLoadedContent.kt
new_jobs/new_jobs_detail/content/JobDetailLoadedContent.kt
```

Do not include README/playbook/root docs unless the task is documentation or agent-config work.

### `checklist`

Checklist should contain concrete, executable implementation logic. Do not duplicate generic prompt-template instructions here. All work logic that must be done belongs in checklist items.

Good:

```text
- Confirm the current start-job enablement path used by Job Detail.
- Add regression tests for future/today/past start dates.
- Fix the date comparison so future dates disable the start button.
- Verify existing non-start-job actions are unchanged.
- Run targeted tests and report results.
```

Bad:

```text
- Read Jira.
- Understand task.
- Fix bug.
- Test.
```

### `acceptanceCriteria`

Acceptance criteria must be observable and pass/fail.

Good:

```text
- Start-job button is disabled when jobStartDate is after today.
- Start-job button is enabled when jobStartDate is today.
- Start-job button is enabled when jobStartDate is before today.
- Existing non-start-job primary actions keep their current behavior.
```

Avoid implementation-only criteria such as "use LocalDate correctly". Put that in checklist/repoContext.

### `verification`

Verification must prove completion.

Include:

- Unit tests to add/update.
- Manual scenarios.
- Targeted build/test commands when known.
- Regression checks.
- Device/OS only when relevant.

Example:

```text
- Add/update tests for tomorrow, today, and yesterday start dates.
- Run the targeted Gradle test for JobStartActionDateRuleTest.
- Run the targeted Gradle test for JobDetailActionMappingTest.
- Manually verify Job Detail shows "เริ่มงาน" disabled for future start date.
- Manually verify Job Detail shows "เริ่มงาน" enabled for today and past start dates.
```

If exact command is unknown:

```text
Run the most targeted Gradle test command available for the affected test class, then run the smallest compile/build command needed to verify the app module still compiles.
```

### `reasoning`

Use `reasoning` for:

- Why this card is scoped this way.
- Why cards were merged.
- Why the work was split into subtasks.
- Why target files are limited.
- Why a card is blocked.
- Why certain files/flows are excluded.

Do not use it for raw Jira metadata dumps.

### `jiraKey`

Always fill when the task comes from Jira.

For merged Jira work, use the primary Jira key if only one value is supported, and include all keys in title/description.

### `sourceUrl`

Keep empty by default.

Do not make the agent depend on Jira or private links.

Use only when the URL is stable, accessible, and truly required.

### `designImages`

Use only when the agent needs direct visual inputs and the images are accessible.

Otherwise summarize attachments into the card.

## Jira Data Placement

| Jira data | Where to put it | Rule |
|---|---|---|
| Jira key | title, `jiraKey` | Always keep |
| Summary | title/description | Rewrite as action-oriented task |
| Description | description | Extract actionable requirement |
| Issue type | description or omit | Include only if useful |
| Priority | Dev Flow priority | Do not repeat in description |
| Labels | description or repoContext | Keep only useful labels |
| Parent/Epic | reasoning or omit | Include only if scope-impacting |
| Device/OS/app version | verification | Include only if relevant to reproduction |
| Attachments | summarize into card | Do not tell agent to open Jira |
| Comments | summarize into card | Include only actionable details |
| Subtasks | summarize or create child tasks | Do not make agent read Jira subtasks |
| Reporter/assignee/timestamps | omit | Not useful for coding |

## Attachment Rules

When Jira has attachments:

1. Inspect them when possible.
2. Classify them as screenshot, video, log, design, document, or irrelevant.
3. Extract actionable requirements or reproduction evidence.
4. Put the extracted meaning into the card.
5. Do not tell the agent to open the attachment.

Good:

```text
Visual evidence shows the tab row scrolls away with content instead of staying pinned under the header.
```

Bad:

```text
See Jira attachment.
```

## Comments, Subtasks, and Linked Issues

Read them when available.

Include only details that affect:

- requirement
- scope
- reproduction
- acceptance criteria
- implementation constraints
- tests

Ignore assignment chatter, timestamps, and non-actionable comments.

For subtasks:

- Merge into the parent card when small.
- Create child Dev Flow tasks when large or parallelizable.
- Do not make the agent read Jira subtasks.

## Reviewable Card Rule

When writing a card that will later move to `ready-for-review`, make the handoff easy to verify from the real implementation:

- Write checklist items so each one can be verified against code, diff, tests, or a manual scenario.
- Avoid checklist items that only repeat the task title or ask for generic "review" without a concrete artifact.
- Include exact files, flows, or behaviors a reviewer should inspect when that matters.
- Keep parent-task checklist items focused on integration and final behavior, not on child implementation details.
- If a task needs visual verification, put the expected visible result into `verification` or `acceptanceCriteria`, not only in comments or informal notes.

## Status Rules

Use:

- `backlog`: requirement needs review, user only asked to create card, or work should not auto-start.
- `todo`: implementation-ready and user wants it ready for execution.
- `in-progress`: actively being worked.
- `ready-for-review`: implementation finished and needs review.
- `done`: reviewed and accepted.

If the user only says "write a card", prefer `backlog` unless they clearly want implementation-ready work.

If the user asks "make it ready for agent" or similar, use `todo` only when Jira and repo context are complete.

Blocked/prep cards must stay in `backlog`.

## Agent / Model / Effort Rules

Assign agent/model/effort only when the user wants the card ready for execution or project convention requires it.

Suggested Android default:

```text
agent: Codex
model: GPT-5.4 Mini or GPT-5.4
effort: medium
```

Use higher effort for:

- subtle UI behavior
- architecture changes
- multi-flow tasks
- high regression risk
- integration/orchestration tasks

Review/planning cards may omit agent assignment.

## Existing Task Rules

Before creating a card:

1. Search Dev Flow tasks by Jira key.
2. If a matching card exists, update it.
3. Create a new card only when no matching task exists.
4. Avoid duplicate cards unless intentionally creating child tasks.

When updating:

- Preserve useful context.
- Remove stale/guessed info.
- Replace guesses with confirmed Jira/repo facts.
- Keep Jira key in title and `jiraKey`.
- Keep target files focused.
- Update status only if readiness changed.

## Blocked Card Rules

Create a blocked/prep card only when:

- Jira cannot be accessed.
- Critical attachments cannot be read.
- Requirements are missing or contradictory.
- Repo cannot be inspected.
- The user asks to preserve work even though it is not ready.

Blocked cards must:

- Use `backlog`.
- Clearly state what is missing.
- Avoid assigning implementation work.
- Avoid pretending the requirement is known.
- Include next steps to unblock.

## Source-of-Truth Quality Gate

Before creating or updating a Dev Flow card, verify:

- Jira was read or missing Jira is clearly blocked.
- Repo was inspected or missing repo is clearly blocked.
- The card can be implemented without opening Jira.
- The title starts with Jira key for Jira-originated work.
- `jiraKey` is filled.
- Description contains requirement, not metadata dump.
- Required wording is included exactly.
- Similar Jira issues were considered for merge.
- Large work was considered for decomposition.
- Parent/subtask branch pattern is used when split.
- `repoContext` contains useful technical findings.
- `targetFiles` are focused and short.
- Checklist is concrete.
- Acceptance criteria are pass/fail.
- Verification has concrete tests/scenarios.
- Attachments/comments/subtasks are summarized when relevant.
- `sourceUrl` is empty unless truly required.
- The card does not instruct the agent to read Jira.
- Scope is narrow enough to avoid over-fixing.

## Good Card Example

```text
title:
[QCA-3393] Fix start-job button date enable rule on Job Detail

description:
Fix the Job Detail primary action rule for accepted jobs.

Screen: My Jobs > Job Detail

Problem:
The "เริ่มงาน" button enable/disable state is inverted against the job start date.

Expected rule:
- If jobStartDate is after today, "เริ่มงาน" must be disabled.
- If jobStartDate is today or before today, "เริ่มงาน" must be enabled.

Concrete examples:
- Today = 15/06/2026
- jobStartDate = 16/06/2026 -> disabled
- jobStartDate = 15/06/2026 -> enabled
- jobStartDate = 14/06/2026 -> enabled

Out of scope:
Do not change other Job Detail primary actions unless they use the same incorrect start-job date rule.

targetFiles:
- JobStartActionDateRule.kt
- JobDetailActionMapping.kt
- JobDetailViewModel.kt
- JobStartActionDateRuleTest.kt
- JobDetailActionMappingTest.kt

acceptanceCriteria:
- Start-job button is disabled when jobStartDate is after today.
- Start-job button is enabled when jobStartDate is today.
- Start-job button is enabled when jobStartDate is before today.
- Existing non-start-job primary actions keep their current behavior.

verification:
- Add/update tests for tomorrow, today, and yesterday start dates.
- Run targeted tests for JobStartActionDateRuleTest.
- Run targeted tests for JobDetailActionMappingTest.
- Manually verify Job Detail start-job button state for future, today, and past start dates.
```

## Bad Card Example

```text
title:
Fix bug

description:
Jira key: QCA-3393
Type: Bug
Priority: High
Parent Jira: QCA-3188
Label: Android
Reporter: ...
Assignee: ...
Please read Jira and fix it.

targetFiles:
- app/src/main/java/...
- README.md
- AGENTS.md

acceptanceCriteria:
- Fix bug.
```

## Final Rule

A good Dev Flow card is not a copy of Jira.

A good Dev Flow card is the result of deep analysis: read Jira, read attachments, read the repo, merge duplicate logic when appropriate, split large work when needed, extract exact wording, identify technical context, and write a focused source-of-truth task that an agent can execute safely.
