# Dev Flow Agent Playbook

## Purpose

This playbook is a portable guide for using ChatGPT with Dev Jira, Dev Github, and Dev Flow to turn Jira requirements into implementation-ready Dev Flow tasks.

It is meant to be shared with another user or another ChatGPT project so the workflow can be used without re-discovering all rules from scratch.

## Required Tools

The workflow assumes access to these tools/connectors:

- `Dev_Jira`: read Jira issues, subtasks, comments, attachments when needed.
- `Dev_Github`: inspect repository structure, files, existing patterns, and implementation entry points.
- `Dev_Flow`: create/update/list tasks and projects.

## Core Principle

Dev Flow cards are the source of truth for the coding agent.

Jira is used by ChatGPT only while preparing the card. The coding agent should not be instructed to go back to Jira, read Jira subtasks, or depend on Jira attachments as the main requirement source.

Do not write instructions like:

```text
Read Jira QCA-1234 and implement it.
```

Instead, convert the Jira content into concrete Dev Flow fields: `description`, `repoContext`, `checklist`, `acceptanceCriteria`, and `verification`.

## Standard Workflow

When the user gives a Jira URL or Jira key:

1. Read the Jira parent issue from `Dev_Jira`.
2. Read subtasks, comments, and attachments if they contain requirements.
3. Read the relevant repository from `Dev_Github`.
4. Identify:
   - repo/project
   - feature area/module
   - entry point files
   - existing patterns
   - likely files to modify or create
   - risks and unknowns
5. Decide whether the work should be:
   - a single task
   - parent + child tasks
   - parent foundation task + parallel child tasks
6. Choose agent/model/effort based on scope, risk, and available agent.
7. Create Dev Flow task(s).
8. Read/list the created tasks if needed to verify fields were saved correctly.
9. Reply to the user with task IDs, titles, agent/model/effort, and split rationale.

## Default Project Mapping

Known Dev Flow project:

```text
buddy2 = https://github.com/q-chang/buddy-android
```

Do not hard-code the project ID if the chat is new. Confirm with:

```text
Dev_Flow.list_projects
```

## New Chat Quick Start

In a new chat, start by checking:

```text
Dev_Flow.get_schema
Dev_Flow.list_projects
```

Then use this prompt pattern:

```text
Use the Dev Flow playbook rules.
buddy2 = q-chang/buddy-android.
Dev Flow card is the source of truth for the coding agent.
Do not instruct the agent to read Jira.
Pull Jira QCA-xxxx, inspect repo context, then create Dev Flow card(s).
```

## Agent Defaults

Default agent:

```text
Codex
```

Use a different agent only when the user explicitly asks, for example:

- `Antigravity`
- `Claude`

## Agent to Model Mapping

Use only models that match the selected agent.

| Agent | Allowed model family |
|---|---|
| Codex | GPT models |
| Antigravity | Gemini models |
| Claude | Claude models |

Examples:

```json
{
  "agent": "Codex",
  "model": "GPT-5.4"
}
```

```json
{
  "agent": "Antigravity",
  "model": "Gemini 3.1 Pro"
}
```

```json
{
  "agent": "Claude",
  "model": "Claude 4.6 Sonnet"
}
```

Do not assign `GPT-5.4` to `Antigravity`.

## Model Selection Principles

Choose model by evaluating:

- scope size
- uncertainty
- number of files/screens
- whether new files/pages/navigation are needed
- preview/share/file handling complexity
- regression risk
- verification cost
- whether the work can be isolated into smaller subtasks

### Token Saving Rules

Do not default to the most expensive model.

Use lower models when the task is bounded, existing patterns are clear, and the parent/foundation task defines shared contracts.

Good token-saving pattern:

- Parent foundation/review task: stronger model.
- Small child layout task: lower model.
- New screen with navigation/preview/share: stronger model.

Example for Codex:

| Work type | Suggested model | Effort |
|---|---|---|
| text/config/simple UI tweak | GPT-5.4 Mini | low |
| existing layout/visibility change | GPT-5.4 Mini or GPT-5.4 | medium |
| medium bug with repo context | GPT-5.4 | medium |
| new page + navigation + preview/share | GPT-5.4 | high |
| architecture/refactor/high uncertainty | GPT-5.5 | high/xhigh |

Example for Antigravity:

| Work type | Suggested model | Effort |
|---|---|---|
| small layout/config task | Gemini 3.5 Flash | low/medium |
| multi-screen or new-page work | Gemini 3.1 Pro | high |
| complex integration/high uncertainty | Gemini 3.1 Pro | high/xhigh |

## When to Split Tasks

Split into parent + child tasks when:

- there are multiple screens/pages
- subtasks map to separate feature slices
- there is shared navigation/preview/model infrastructure
- work can be done in parallel
- implementation would touch many files
- QA can verify slices separately

Do not split when:

- it is a small bug with one or two target files
- the task is a single config/link/text change
- splitting creates more overhead than value

## Parallel Task Strategy

For parallel work, the parent should not be only an overview. The parent should be the foundation, merge, and review owner.

Parent responsibilities:

- define shared contracts
- define navigation route/action contracts
- define preview/open/share strategy
- establish base branch
- prevent duplicate infrastructure
- review and merge child branches
- run final integration verification

Child responsibilities:

- implement one feature slice
- avoid touching files owned by other child tasks unless required
- branch from the parent foundation branch
- use the shared contract defined by the parent
- avoid creating duplicate preview/navigation infrastructure

## Parallel Branch Pattern

Use a shared foundation branch:

```text
feature/<task>-foundation
```

Child branches:

```text
feature/<task>-foundation/<subtask>
```

Example:

```text
feature/qca-3242-foundation
feature/qca-3242-foundation/details-tab-layout
feature/qca-3242-foundation/site-info-page
feature/qca-3242-foundation/documents-page
```

## Source of Truth Rules

- Dev Flow task fields are the implementation source of truth.
- Do not tell the coding agent to read Jira.
- Do not rely on Jira attachment URLs as required implementation input.
- `sourceUrl` should be empty by default unless traceability is specifically requested.
- Jira key can be stored in `jiraKey` and tags for search/traceability.
- Child task titles should not include Jira subtask IDs. Use clear work titles instead.

Good child titles:

```text
Update installation Details tab layout and section visibility
Create Site Info detail page with customer attachments
Create Documents detail page grouped by document type
```

Bad child titles:

```text
[QCA-3243] Update installation Details tab layout
[QCA-3244] Create Site Info page
```

## Visuals and Attachments

If Jira contains important images:

- read them while preparing the card
- summarize requirements into Dev Flow fields
- optionally add a visual reference into `designImage`
- do not make the agent depend on opening Jira attachments

If the image URL needs Jira authentication, it may not work for the agent. Prefer a stable accessible URL or summarize the image into requirements.

## Agent Work Completion & Verification

After finishing the implementation for a Dev Flow card, agents must use the task's checklist (mini-tasks) as a strict correctness verification gate before marking the task `ready-for-review`.

Rules for mini-tasks/checklist:
1. Review the checklist for the task.
2. Verify that each checklist item has actually been implemented and functions correctly.
3. Mark verified items as completed using the `toggle_task_checklist` MCP tool.
4. If an item cannot be verified or is not completed, **do not** check it off. Instead, leave it unchecked and add a short note/log to the task explaining why.
5. Do not blindly mark all items as completed without verification.
6. Only move the card to `ready-for-review` after this checklist verification process is done.

## Final Response Pattern

After creating cards, respond briefly:

```text
Created Dev Flow card(s):

Parent:
- <task id>
- <title>
- Agent/Model/Effort
- Branch

Children:
- <task id> — <title> — <Agent/Model/Effort> — <branch>

Split rationale:
<short reason>
```

Do not paste the full task JSON unless the user asks.
