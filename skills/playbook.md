# Dev Flow Agent Playbook

## Purpose

This playbook defines how ChatGPT should use Jira, GitHub/repository context, and Dev Flow to convert product or engineering requirements into high-quality, implementation-ready Dev Flow tasks.

The output of this workflow is a Dev Flow card, or a parent/child task set, that a coding agent can execute without re-opening Jira, guessing requirements, rediscovering obvious repository context, or receiving vague instructions.

This playbook is portable. It can be copied into another ChatGPT project or shared with another user so the same Jira-to-DevFlow workflow can be reused consistently.

---

## Required Tools

The workflow assumes access to these tools/connectors when available:

- `Dev_Jira`: read Jira issues, subtasks, comments, attachments, priorities, statuses, and issue relationships.
- `Dev_Github`: inspect repository structure, files, existing patterns, pull requests, issues, and code references.
- `Dev_Flow`: create, update, list, move, assign, inspect, and render Dev Flow tasks and projects.

When a tool is unavailable or returns insufficient data, ChatGPT must say so honestly and must not fill the gap with guessed requirements.

---

## Core Principle

Dev Flow cards are the source of truth for the coding agent.

Jira is used by ChatGPT only while preparing the card. The coding agent must not be instructed to go back to Jira, read Jira subtasks, open Jira attachments, or depend on Jira links as the main requirement source.

Do not write instructions like:

```md
Read Jira QCA-1234 before coding.
Open the Jira attachment and check what to do.
Use the Jira comments as the source of truth.
See sourceUrl for the requirement.
```

Instead, ChatGPT must read Jira, inspect relevant repository context, summarize everything needed, and write the final requirement into the Dev Flow card fields.

A good Dev Flow card is not a copy of Jira.

A good Dev Flow card is the result of reading Jira, reading the repo, filtering noise, extracting requirements, analyzing implementation risk, deciding task size, and writing focused execution context.

---

## Operating Mode

### Read first, write later

Before creating or updating a Dev Flow card, ChatGPT must read all required sources first.

Recommended order:

1. Read the Jira issue.
2. Read Jira comments.
3. Read Jira subtasks or linked issues when they affect scope.
4. Read Jira attachments when they contain screenshots, videos, logs, designs, or reproduction evidence.
5. Read the target repository.
6. Search the repository for relevant screens, classes, APIs, tests, strings, routes, and existing patterns.
7. Read existing Dev Flow tasks for the same Jira key or same feature area.
8. Read the Dev Flow schema or project rules when needed.
9. Think deeply about implementation scope, risks, and decomposition.
10. Create or update the Dev Flow card only after the requirement, implementation area, and task shape are understood.

### Do not create implementation cards from guesses

If Jira cannot be read and the user did not provide enough requirement detail, do not create an implementation-ready card.

Either ask for the missing requirement, or create a blocked/prep card that clearly states what is missing.

A blocked card must not be assigned as ready implementation work.

---

## Deep Analysis Requirement

Before writing any Dev Flow card, ChatGPT must analyze the task deeply.

Do not create a card immediately after reading Jira. First reason through the requirement and convert raw Jira/repo information into an executable engineering plan.

Before writing the final card, answer these internally:

- What is the real user-facing problem?
- What exact behavior is wrong?
- What exact behavior is expected?
- What examples from Jira prove the rule?
- What is the smallest safe implementation scope?
- Which app screen, flow, API, model, mapper, state, or repository layer is likely affected?
- Which existing behavior must not change?
- What files are likely implementation files?
- What files are likely test files?
- What risks exist?
- Is the task small enough for one agent to complete safely?
- Is the task too large, cross-layer, or risky?
- Can the work be split into independent subtasks that can run in parallel?
- If split, what should the parent orchestrator own and what should each child task own?

The final Dev Flow card must reflect this analysis. It should not be a raw Jira copy or a metadata dump.

---

## Task Sizing and Decomposition Rules

### Decide whether the task is single-card or orchestrated

Every task must be sized before writing the card.

Use a single implementation card only when:

- The scope is narrow.
- One agent can complete it safely.
- The expected files are focused.
- The behavior has clear acceptance criteria.
- There is low integration risk.
- Splitting would create unnecessary overhead.

Use a parent orchestrator plus child subtasks when the task is large, multi-layer, or risky.

A task should be considered large when it includes any of these:

- Multiple screens or flows.
- Multiple architectural layers such as UI, domain, repository, API, local storage, and tests.
- Multiple independent behaviors.
- Significant refactor plus feature/bug fix.
- Complex UI behavior with independent state, layout, analytics, navigation, and tests.
- Risk of merge conflicts if multiple agents edit the same file.
- Unclear sequencing or integration risk.
- More than one agent could reasonably work on different parts in parallel.
- The implementation naturally has foundation work plus feature slices.

If a task is large, do not create one oversized implementation card.

Split it into:

1. A parent orchestration/foundation task.
2. Multiple child subtasks that can be worked on independently.
3. A final integration/review step owned by the parent task.

---

## Parent Orchestrator Rule

For large tasks, the parent task is not a normal coding task.

The parent task is an orchestrator/foundation task.

The parent should:

- Define the full source-of-truth requirement.
- Define overall architecture, constraints, and boundaries.
- Define the branch naming plan.
- Define child subtasks.
- Assign each child subtask a clear independent scope.
- Minimize target file overlap between child subtasks.
- Define integration points between subtasks.
- Define shared contracts, models, interfaces, or behavior that child tasks must respect.
- Track completion of child subtasks.
- Own final integration/review after child tasks are complete.
- Own final acceptance criteria and verification for the whole Jira issue.

The parent should not tell one agent to implement everything if the work has been split.

The parent may include foundation/setup work when needed, but it must still be written as an orchestrator with clear child boundaries.

---

## Parallel Subtask Rule

Child subtasks must be designed so they can run in parallel as much as possible.

A good parallel subtask:

- Has a clear independent scope.
- Has focused target files.
- Avoids editing the same files as other subtasks when possible.
- Has its own acceptance criteria.
- Has its own verification steps.
- Does not require another subtask to finish before it can start, unless explicitly stated.
- Produces output that can be integrated by the parent orchestrator.
- States any dependency on foundation work clearly.

Bad subtasks:

- `Do part 1`
- `Do part 2`
- `Fix remaining things`
- `Update everything`
- Multiple subtasks that all edit the same large file without coordination.
- Subtasks that cannot be verified independently.
- Subtasks that are only checklist items disguised as tasks.

If subtasks cannot run in parallel, explain the sequencing clearly in the parent card.

---

## Branch Naming for Orchestrated Work

When a large task is split into a parent orchestrator and parallel subtasks, branch names must follow this pattern.

Parent branch:

```text
xxxx-foundation
```

Child subtask branches:

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

- The parent branch must end with `-foundation`.
- Child branches must be nested under the parent foundation branch.
- Child branch names should describe the subtask scope.
- Child subtasks should branch from the parent foundation branch when shared groundwork is needed.
- The parent orchestrator is responsible for merging or reconciling child outputs.

For single-card non-orchestrated work, use normal branch naming:

```text
fix/qca-3393-start-job-button-date-rule
feature/qca-1234-new-job-filter
chore/qca-1234-refactor-job-detail
```

---

## Decomposition Quality Gate

Before creating a single implementation card, ChatGPT must check:

- Can this be completed safely by one agent?
- Will one card become too large or vague?
- Are there independent parts that can be done in parallel?
- Would parallel subtasks reduce risk or speed up delivery?
- Will subtasks avoid overlapping target files?
- Is a parent orchestrator needed to coordinate integration?
- Is there a foundation branch needed before child branches?
- Does the parent have a clear integration plan?

If the answer suggests the task is large, create a parent orchestrator task and child subtasks instead of one oversized card.

---

## Parent and Child Card Requirements

### Parent orchestrator card

The parent card must include:

- Full Jira/source requirement.
- Overall architecture/context.
- Deep analysis summary.
- Subtask breakdown.
- Branch naming plan.
- Integration plan.
- Shared constraints.
- Known risks.
- Final acceptance criteria.
- Final verification plan.

The parent title must still start with the Jira key when Jira-originated.

Example:

```text
[QCA-3400] Orchestrate Job Detail foundation fixes
```

Parent branch:

```text
qca-3400-job-detail-foundation
```

### Child subtask card

Each child card must include:

- Jira key in title.
- Parent task reference.
- Narrow independent scope.
- Focused target files.
- Subtask-specific acceptance criteria.
- Subtask-specific verification.
- Branch nested under parent foundation branch.
- Integration notes for the parent.

Example:

```text
[QCA-3400] Implement sticky Job Detail tabs
```

Child branch:

```text
qca-3400-job-detail-foundation/sticky-tabs
```

Child tasks should not repeat the full parent requirement unless needed. They should reference the parent and contain only the context needed for their independent scope.

---

## Integration Rule

After child subtasks are complete, the parent orchestrator must verify integration.

Integration must check:

- Child outputs do not conflict.
- Shared contracts still match.
- All parent acceptance criteria are satisfied.
- Tests from child tasks pass together.
- Manual verification covers the full user flow.
- No child task changed out-of-scope behavior.
- Branches are merged or reconciled in the expected order.

The parent should move to `ready-for-review` only after integration is complete and verified.

---

## Jira-to-DevFlow Conversion Rules

### Card must be implementation-ready

A Dev Flow card must contain enough information for the coding agent to complete the task from the card alone.

It should include:

- What screen, flow, feature, API, or module is affected.
- What the wrong behavior is.
- What the expected behavior is.
- Exact business rules.
- Concrete examples from Jira.
- Relevant repo context.
- Focused target files.
- Observable acceptance criteria.
- Concrete verification steps.
- Out-of-scope boundaries.
- Known risks or implementation warnings.

### Card must not be a Jira metadata dump

Do not blindly copy Jira fields into the card description.

Metadata that does not help implementation or verification should be omitted from the description.

Examples of Jira metadata that usually does not belong in `description`:

```text
Type: Bug
Priority: High
Parent Jira: QCA-3188
Label: Android
Reporter: ...
Assignee: ...
Created date: ...
Updated date: ...
Sprint: ...
Board: ...
```

Use metadata only when it affects implementation, reproduction, or verification.

---

## Title Rule

If a task comes from Jira, the parent/main Dev Flow task title must start with the Jira key.

Good:

```md
[QCA-3393] Fix start-job button date enable rule on Job Detail
```

Bad:

```md
Fix start-job button date enable rule on Job Detail
```

The Jira key must also be stored in the `jiraKey` field when available.

Use tags for traceability, but do not rely only on tags.

For child tasks from the same Jira issue, child titles should also start with the Jira key.

---

## Field Writing Rules

### `title`

The title should be short, specific, and action-oriented.

Format for Jira tasks:

```md
[JIRA-KEY] Verb + object + context
```

Examples:

```md
[QCA-3363] Fix Job Detail tabs to behave like a sticky header while scrolling
[QCA-3393] Fix start-job button date enable rule on Job Detail
```

Avoid vague titles:

```md
[QCA-3393] Fix bug
[QCA-3393] Job detail issue
[QCA-3393] Android task
```

### `description`

The description should contain the core product requirement.

It should answer:

- What is affected?
- What is currently wrong?
- What should happen instead?
- What exact rules or examples must be followed?
- What is out of scope?

Do not put raw Jira metadata here unless it is directly relevant to the implementation or reproduction.

Good description:

```md
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
Do not change other Job Detail primary actions unless they share the same start-job date rule bug.
```

Bad description:

```md
Jira key: QCA-3393
Type: Bug
Priority: High
Parent Jira: QCA-3188 Job Flow
Label: Android
Screen: Job Detail
Reported device: Samsung Galaxy Z Flip 6
OS: Android 15
App version: 2.0.114
```

### `repoContext`

`repoContext` should contain technical context discovered from the repository.

Use it for:

- Relevant files and components.
- Existing implementation behavior.
- Existing helper functions.
- Existing tests.
- Related flows that must remain unchanged.
- Known implementation risks.
- Architecture or pattern notes.
- Warnings about repo-specific behavior.
- Decomposition notes when the task is split.

Good `repoContext`:

```md
Repo inspection summary:
- Job Detail primary action state is mapped through JobDetailActionMapping.
- JobStartActionDateRule contains the date comparison helper used for start-job enablement.
- Current helper appears intended to enable start-job when startDate is not after today.
- Verify whether the bug still exists in another path or if the current helper is a partial fix.
- Existing tests include JobStartActionDateRuleTest and JobDetailActionMappingTest.

Implementation warning:
Do not change non-start-job actions such as finish-job, upload document, or quotation actions unless tests prove they use the same incorrect rule.
```

Do not use `repoContext` as a place to dump Jira metadata.

### `reasoning`

Use `reasoning` for why the card is shaped this way.

Good uses:

- Why a bug is likely in a certain mapper/helper.
- Why target files are limited.
- Why a card is blocked.
- Why certain related files were excluded.
- Why scope is intentionally narrow.
- Why the task is single-card or split into parent/child tasks.
- Why subtasks can or cannot run in parallel.

Do not use `reasoning` for long Jira metadata dumps.

### `targetFiles`

`targetFiles` must be focused and minimal.

Prefer short file names, not full paths, unless duplicate filenames make the short name ambiguous.

Good:

```text
JobStartActionDateRule.kt
JobDetailActionMapping.kt
JobDetailViewModel.kt
JobStartActionDateRuleTest.kt
JobDetailActionMappingTest.kt
```

Acceptable when duplicates exist:

```text
my_jobs/my_jobs_detail/content/JobDetailLoadedContent.kt
new_jobs/new_jobs_detail/content/JobDetailLoadedContent.kt
```

Bad:

```text
app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/mapper/JobDetailActionMapping.kt
app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/JobDetailViewModel.kt
app/src/test/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/mapper/JobDetailActionMappingTest.kt
```

Do not include broad or unrelated files just because they were inspected.

Do not include root docs, README files, or playbooks as target files unless the task is actually about documentation or agent configuration.

For orchestrated work, parent `targetFiles` may be empty or contain high-level shared files only. Child `targetFiles` must be focused on each child scope.

### `checklist`

Checklist items should be concrete implementation steps.

Good checklist:

```md
- Locate the existing start-job enablement rule used by Job Detail.
- Add regression coverage for future/today/past start dates.
- Fix the date comparison so future dates disable the start button.
- Verify existing non-start-job actions are unchanged.
- Run targeted tests and report results.
```

Bad checklist:

```md
- Read Jira.
- Understand task.
- Fix bug.
- Test.
```

Checklist items should not send the agent back to Jira.

For parent orchestrator tasks, checklist should track child task creation, child completion, integration, and final verification.

### `acceptanceCriteria`

Acceptance criteria must be observable and testable.

Each item should describe a pass/fail behavior.

Good:

```md
- Start-job button is disabled when jobStartDate is after today.
- Start-job button is enabled when jobStartDate is today.
- Start-job button is enabled when jobStartDate is before today.
- Tab selection still works when the Job Detail tab row is sticky.
- Existing non-start-job primary actions keep their current behavior.
```

Bad:

```md
- Fix logic.
- Check screen.
- Make it work.
- Follow Jira.
```

Acceptance criteria should be written from the product/user behavior perspective.

Avoid implementation-only criteria unless the implementation detail is itself required.

### `verification`

Verification must tell the agent how to prove the task is complete.

It should include:

- Unit tests to add or update.
- Manual scenarios to verify.
- Build/test commands when known.
- Device or OS checks only when relevant to reproduction.
- Regression checks for related behavior.
- Integration verification for parent orchestrator tasks.

Good:

```md
- Add or update unit tests for:
  - tomorrow date -> disabled
  - today date -> enabled
  - yesterday date -> enabled
- Run the targeted Gradle test for JobStartActionDateRuleTest.
- Run the targeted Gradle test for JobDetailActionMappingTest.
- Manually verify Job Detail shows "เริ่มงาน" disabled for a future start date.
- Manually verify Job Detail shows "เริ่มงาน" enabled for today and past start dates.
```

Device, OS, and app version should usually go in `verification` only when they matter for reproduction.

Example:

```md
- When possible, verify on a small/foldable device profile similar to Samsung Galaxy Z Flip 6 / Android 15.
```

When exact commands are unknown, write:

```md
Run the most targeted Gradle test command available for the affected test class, then run the smallest compile/build command needed to verify the app module still compiles.
```

Do not invent commands if the repo was not inspected enough to confirm them.

### `tags`

Tags should be short and useful for filtering.

For Jira tasks, include:

- Jira key
- platform or module
- issue type if useful
- feature/screen area

Good:

```text
QCA-3393
Android
Bug
Job Detail
My Jobs
```

Avoid copying every Jira label, component, parent, and metadata field into tags.

### `priority`

Map Jira priority to Dev Flow priority only when useful.

Suggested mapping:

- Jira Highest / High -> Dev Flow `high`
- Jira Medium -> Dev Flow `medium`
- Jira Low / Lowest -> Dev Flow `low`

Do not repeat priority in `description`.

### `branch`

Use a predictable branch name.

Single-card Jira tasks:

```text
fix/qca-3393-start-job-button-date-rule
feature/qca-1234-new-job-filter
chore/qca-1234-refactor-job-detail
```

Orchestrated parent/child tasks:

```text
qca-3400-job-detail-foundation
qca-3400-job-detail-foundation/ui-sticky-tabs
qca-3400-job-detail-foundation/date-rule-tests
```

Branch name should be lowercase and descriptive.

### `jiraKey`

Always fill `jiraKey` when the task comes from Jira.

Example:

```text
QCA-3393
```

### `sourceUrl`

`sourceUrl` should be empty by default.

Do not make the coding agent depend on Jira, Jira attachments, or private external links.

Only use `sourceUrl` when the external URL is stable, accessible to the agent, and required for implementation.

For normal Jira tasks, prefer:

- `jiraKey`: filled
- `sourceUrl`: empty

### `designImages`

Use `designImages` only when the coding agent actually needs direct visual inputs and the image is accessible in the Dev Flow environment.

If Jira has screenshots or videos, ChatGPT should inspect or summarize them while preparing the card.

Do not write:

```md
Open the Jira attachment and inspect the screenshot.
```

Instead write:

```md
Visual evidence from Jira shows the tab row scrolls away with content instead of staying pinned under the header.
```

---

## Jira Data Placement Rules

| Jira data | Where to put it | Rule |
|---|---|---|
| Jira key | `title`, `jiraKey`, `tags` | Always keep |
| Summary | `title` and `description` | Rewrite into action-oriented task language |
| Description | `description` | Extract only actionable requirement |
| Issue type | Usually omit or tag | Include only if useful |
| Priority | Dev Flow `priority` | Do not repeat in description |
| Label | `tags` | Keep only useful labels |
| Parent / Epic | Usually omit or `reasoning` | Include only if it affects scope or decomposition |
| Components | `tags` or `repoContext` | Include only if technically useful |
| Device | `verification` | Include only when relevant to reproduction |
| OS | `verification` | Include only when relevant to reproduction |
| App version | `verification` | Include only when relevant to reproduction |
| Reporter | omit | Not useful for coding |
| Assignee | omit | Not useful for coding |
| Created/updated dates | omit | Not useful for coding |
| Attachments | summarize into description / acceptance / verification | Do not tell agent to open Jira |
| Comments | summarize into description / reasoning | Include only actionable details |
| Subtasks | summarize or create child Dev Flow tasks | Do not make agent read Jira subtasks |
| Linked issues | summarize only if scope-impacting | Avoid noisy metadata |

---

## Attachment Rules

When Jira has attachments:

1. Inspect attachments when possible.
2. Identify whether each attachment is:
   - screenshot
   - video
   - log
   - design
   - document
   - irrelevant
3. Extract actionable requirements or reproduction evidence.
4. Write the extracted meaning into the card.
5. Do not require the coding agent to open the attachment.

Good:

```md
Visual evidence:
The screenshot shows the "รายละเอียด / ข้อมูลการทำงาน" tab row moving off-screen while the header remains visible. The expected behavior is for the tab row to pin below the header once it reaches that position.
```

Bad:

```md
See attached screenshot in Jira.
```

---

## Comments and Subtasks Rules

### Comments

Read Jira comments when available.

Only include comments that affect:

- requirements
- scope
- reproduction
- acceptance criteria
- implementation constraints
- test expectations
- task decomposition

Do not include thank-you notes, assignment chatter, or timestamps.

### Subtasks

If Jira has subtasks:

- Read them before writing the card.
- Decide whether they should be:
  - merged into the parent card
  - represented as Dev Flow child tasks
  - ignored because they are irrelevant/noisy

Do not write:

```md
Read the Jira subtasks before coding.
```

Instead, summarize the relevant subtask requirements into the card or create child Dev Flow tasks.

---

## Repository Inspection Rules

ChatGPT must inspect the repo enough to make the card actionable.

Minimum repo inspection for code tasks:

1. Identify project structure.
2. Search for the affected screen, feature, strings, route, API, or domain model.
3. Read likely implementation files.
4. Read likely test files.
5. Identify existing patterns.
6. Identify likely target files.
7. Identify risks and related flows that should not be changed.
8. Identify whether the task is single-card or should be decomposed.
9. Identify possible file overlap if multiple child subtasks are created.

Do not include every inspected file in `targetFiles`.

Use `repoContext` to summarize findings.

---

## Dev Flow Project Rules

Before creating a task:

1. Confirm the correct Dev Flow project.
2. Check whether a task for the same Jira key already exists.
3. Update the existing task if it exists.
4. Create a new task only when no matching task exists.

Matching should check:

- `jiraKey`
- title prefix
- tags
- search result by Jira key

Avoid duplicate cards for the same Jira issue unless intentionally creating child tasks.

When creating child tasks, set `parentId` when available.

---

## Status Rules

Suggested status selection:

- `backlog`: requirement needs review, card is not ready, or user did not ask to start work.
- `todo`: implementation-ready and safe for an agent to pick up.
- `in-progress`: actively being worked by an agent or developer.
- `ready-for-review`: implementation finished and needs review.
- `done`: reviewed, verified, and accepted.

If the user asks to "write a card" only, prefer `backlog` unless they explicitly want it ready for execution.

If the user asks to "make it implementation-ready," use `todo` only when the card is complete enough for the agent to start.

If Jira cannot be read, do not use `todo` for implementation work.

For orchestrated work:

- Parent may start in `backlog` for user review or `todo` if ready to orchestrate.
- Child tasks should be `todo` only when their independent scope is clear.
- Parent should not be `done` until child outputs are integrated and verified.

---

## Agent / Model / Effort Rules

Assign agent/model/effort only when the user wants the task ready for execution or the project convention requires it.

Suggested defaults:

### Android implementation

```text
agent: Codex
model: GPT-5.4 Mini or GPT-5.4
effort: medium
```

Use higher effort when:

- the task touches architecture
- behavior is subtle
- there are multiple flows
- UI behavior requires careful Compose logic
- regression risk is high
- the card is a parent orchestrator/foundation task

### Review or planning card

Agent assignment may be omitted unless the user explicitly asks.

### Parent orchestrator

Parent orchestrator cards should use a stronger model/effort when they require planning, integration, or review.

Child implementation tasks can use cheaper/faster workers when the scope is narrow and the parent provides enough context.

---

## Source-of-Truth Quality Gate

Before creating or updating a Dev Flow card, verify:

- The card can be implemented without opening Jira.
- The Jira key is in the title when the task came from Jira.
- `jiraKey` is filled.
- The task has been deeply analyzed before writing.
- The task size has been assessed.
- If the task is large, parent/child decomposition has been considered.
- If split, child tasks can run in parallel as much as possible.
- If split, branch naming follows the foundation pattern.
- `description` contains requirements, not raw Jira metadata.
- `repoContext` contains useful technical findings.
- `targetFiles` are focused and short.
- `acceptanceCriteria` are observable and testable.
- `verification` contains concrete checks.
- Jira attachments are summarized if relevant.
- Jira comments and subtasks are summarized if relevant.
- `sourceUrl` is empty unless truly required.
- The card does not instruct the agent to read Jira.
- The card does not contain unrelated inspected files.
- The scope is narrow enough to avoid over-fixing.

---

## Blocked Card Rules

Create a blocked/prep card only when:

- Jira cannot be accessed.
- Critical attachments cannot be read.
- Requirements are missing or contradictory.
- The repo cannot be inspected enough to identify implementation context.
- The user explicitly asks to preserve the work even though it is not ready.

Blocked cards must:

- Use `backlog`.
- Clearly state what is missing.
- Avoid assigning implementation work.
- Avoid pretending the requirement is known.
- Include next steps to unblock.

Blocked cards must not be written as if the agent can start coding.

Good blocked card description:

```md
QCA-1234 cannot be converted into an implementation-ready card yet because Jira content could not be fetched and the user has not provided the requirement details.

Do not start implementation from this card.
```

---

## Updating Existing Cards

When updating an existing card:

1. Read the current card.
2. Preserve useful existing context.
3. Remove stale or incorrect information.
4. Replace guessed requirements with confirmed requirements.
5. Keep the card source-of-truth.
6. Avoid duplicate Jira metadata.
7. Keep target files focused.
8. Reassess task size and decomposition.
9. Update status only if readiness changed.
10. Keep Jira key in title and `jiraKey`.

If a card was previously blocked and Jira becomes available, rewrite it into an implementation-ready card.

If a single card becomes too large after new information is found, rewrite it as a parent orchestrator and create parallel child subtasks.

---

## Examples

### Example: Good single-card Jira bug

```md
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
Do not change other Job Detail primary actions unless they use the same incorrect start-job rule.

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
- Add or update tests for tomorrow, today, and yesterday start dates.
- Run targeted tests for JobStartActionDateRuleTest.
- Run targeted tests for JobDetailActionMappingTest.
- Manually verify Job Detail start-job button state for future, today, and past start dates.
```

### Example: Good orchestrated Jira task

```md
title:
[QCA-3400] Orchestrate Job Detail foundation updates

branch:
qca-3400-job-detail-foundation

description:
Coordinate the Job Detail foundation update across UI behavior, action mapping, and regression tests.

This parent task owns the full requirement, child task boundaries, branch plan, and final integration verification.

Child tasks:
1. [QCA-3400] Update Job Detail UI state contract
   - branch: qca-3400-job-detail-foundation/ui-state-contract
2. [QCA-3400] Implement Job Detail sticky tabs behavior
   - branch: qca-3400-job-detail-foundation/sticky-tabs
3. [QCA-3400] Add Job Detail regression tests
   - branch: qca-3400-job-detail-foundation/regression-tests

Integration plan:
- Merge child branches into qca-3400-job-detail-foundation.
- Resolve shared model/state conflicts in the parent branch.
- Run combined tests.
- Perform final manual verification of the full Job Detail flow.
```

### Example: Bad Jira bug card

```md
title:
Fix start job

description:
Jira key: QCA-3393
Type: Bug
Priority: High
Parent Jira: QCA-3188 Job Flow
Label: Android
Screen: งานของฉัน > Job Detail
Reported device: Samsung Galaxy Z Flip 6
OS: Android 15
App version: 2.0.114
Please read Jira and fix the issue.

targetFiles:
- app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/mapper/JobDetailActionMapping.kt
- app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/JobDetailViewModel.kt
- README.md
- AGENTS.md

acceptanceCriteria:
- Fix bug.
```

---

## Final Rule

A good Dev Flow card is not a Jira dump.

A good Dev Flow card is a carefully analyzed, source-of-truth engineering task.

For small work, create one focused implementation card.

For large work, create a parent orchestrator/foundation task and parallel child subtasks with clear branch structure:

```text
parent:  xxxx-foundation
child:   xxxx-foundation/xxxx
```

The goal is always the same: make the coding agent successful without guessing, over-editing, or depending on Jira.
