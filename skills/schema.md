# Dev Flow Card Schema and Writing Rules

## Purpose

This document defines how to write Dev Flow cards and what JSON fields/values should be sent to `Dev_Flow.create_task` or `Dev_Flow.update_task`.

It combines card-writing rules, schema reference, allowed values, templates, and examples.

## Current Task Schema

Required fields:

```json
{
  "title": "string",
  "projectId": "string"
}
```

Optional fields:

```json
{
  "description": "string",
  "status": "string",
  "priority": "string",
  "branch": "string",
  "tags": ["string"],
  "targetFiles": ["string"],
  "checklist": [
    {
      "id": "string",
      "text": "string",
      "completed": "boolean"
    }
  ],
  "effort": "low | medium | high | xhigh",
  "model": "model enum",
  "agent": "Codex | Antigravity | Claude",
  "parentId": "string",
  "reasoning": "string",
  "acceptanceCriteria": "string",
  "verification": "string",
  "repoContext": "string",
  "jiraKey": "string",
  "repo": "string",
  "sourceUrl": "string",
  "designImage": "string",
  "specUrl": "string"
}
```

Always confirm the latest schema with:

```text
Dev_Flow.get_schema
```

## Allowed Values

### status

```json
["backlog", "todo", "in-progress", "ready-for-review", "done"]
```

Default:

```text
backlog
```

### priority

```json
["low", "medium", "high"]
```

### effort

```json
["low", "medium", "high", "xhigh"]
```

Do not use old values like `small`, `large`, or `M`.

### agent

```json
["Codex", "Antigravity", "Claude"]
```

Use exact casing.

### model

```json
[
  "GPT-5.5",
  "GPT-5.4",
  "GPT-5.4 Mini",
  "Gemini 3.5 Flash",
  "Gemini 3.1 Pro",
  "Claude 4.8 Opus",
  "Claude 4.7 Opus",
  "Claude 4.6 Opus",
  "Claude 4.6 Sonnet"
]
```

Use exact spelling from schema.

## Agent/Model Mapping

| Agent | Valid models |
|---|---|
| Codex | GPT-5.4 Mini, GPT-5.4, GPT-5.5 |
| Antigravity | Gemini 3.5 Flash, Gemini 3.1 Pro |
| Claude | Claude 4.6 Sonnet, Claude 4.6 Opus, Claude 4.7 Opus, Claude 4.8 Opus |

Invalid examples:

```json
{
  "agent": "Antigravity",
  "model": "GPT-5.4"
}
```

```json
{
  "agent": "Codex",
  "model": "Gemini 3.1 Pro"
}
```

## Field Usage Rules

### title

Use a concise implementation title.

Parent title may include Jira key:

```text
[QCA-3242][Android][Ctr][My Job][Installation] Foundation, merge, and review for Details tab update
```

Child titles should not include Jira subtask IDs:

```text
Create Site Info detail page with customer attachments
```

### description

Keep it short. It should state the goal only.

Do not duplicate Jira summary, implementation checklist, acceptance criteria, or verification here.

Good:

```text
Create the installation Job Detail Site Info detail page from the Details tab and show customer remark plus attachments using the shared preview/open/share behavior.
```

Bad:

```text
Jira Summary:
...
Implementation Checklist:
...
Acceptance Criteria:
...
```

### repoContext

Use this for repo/module/path/package/context.

Include full paths here, especially for new files.

Example:

```text
Repo: q-chang/buddy-android
Area: My Jobs / Installation / Job Detail / Compose

Create new files under:
app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/site_info/

Existing entry points:
- app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/content/JobDetailInfoTab.kt
- app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/section/JobDetailSiteInfoSection.kt

Use the shared preview/open/share contract from the parent foundation task.
```

### reasoning

Explain why the chosen agent/model/effort is appropriate.

Keep it practical:

```text
This is an existing layout/visibility change with clear repo entry points, so Codex with GPT-5.4 Mini is enough. Escalate to GPT-5.4 only if section state or shared navigation contract is unclear.
```

### acceptanceCriteria

Use concrete pass/fail statements.

Example:

```text
- Site Info detail page opens from the Details tab.
- Customer remark is displayed when present.
- Image/video/file attachments are listed correctly.
- Attachment preview/open/share uses the shared behavior from the foundation task.
- Empty attachment state does not crash or show broken UI.
```

### verification

Write manual QA and test/build steps.

Example:

```text
- Open My Job installation detail.
- Go to Details tab.
- Tap Site Info section.
- Verify remark and attachments.
- Open image/video/file attachment.
- Navigate back to Job Detail.
- Run targeted build/test command if available.
```

### checklist

Checklist should be action steps, not vague statements.

Good:

```json
[
  {
    "text": "Create the Site Info route and screen under the agreed site_info package.",
    "completed": false
  },
  {
    "text": "Wire the Details tab Site Info entry point to the new route.",
    "completed": false
  }
]
```

Bad:

```json
[
  {
    "text": "Fix bug",
    "completed": false
  },
  {
    "text": "Make it work",
    "completed": false
  }
]
```

### targetFiles

Use readable file names, not full paths.

Existing files:

```json
[
  "JobDetailInfoTab.kt",
  "JobDetailSiteInfoSection.kt"
]
```

New files should include short directory and `(new)`:

```json
[
  "site_info/JobSiteInfoRoute.kt (new)",
  "site_info/JobSiteInfoScreen.kt (new)",
  "documents/JobDocumentsScreen.kt (new)"
]
```

Full paths belong in `repoContext`.

### jiraKey

Use for traceability:

```json
"jiraKey": "QCA-3242"
```

### repo

Use repository URL:

```json
"repo": "https://github.com/q-chang/buddy-android"
```

### sourceUrl

Leave empty by default to avoid sending the agent back to Jira.

Use only when the user explicitly asks for traceability.

### designImage

Use for visual reference if there is a stable accessible URL.

Do not rely on Jira-authenticated images as the only source of truth.

### specUrl

Use for a stable external spec if available and accessible.

If it requires auth, summarize the requirements into the card fields instead.

## Priority Mapping

| Jira Priority | Dev Flow priority |
|---|---|
| Highest/Critical | high |
| High | high |
| Medium | medium |
| Low | low |
| Lowest | low |

If Jira priority is missing, infer from user impact and write the reason in `reasoning`.

## Effort Guidance

| Effort | Use when |
|---|---|
| low | one file, text/config/link/simple bug |
| medium | bounded UI/state change, existing patterns clear |
| high | new screen, navigation, preview/share, multiple files, parallel branch |
| xhigh | architecture/refactor/multi-module/high uncertainty |

## Single Task Template

```json
{
  "projectId": "project-id",
  "title": "[QCA-xxxx][Android] Short implementation title",
  "description": "Goal summary only.",
  "status": "backlog",
  "priority": "medium",
  "branch": "fix/qca-xxxx-short-name",
  "tags": ["QCA-xxxx", "Android", "Bug"],
  "targetFiles": ["FileA.kt", "FileB.kt"],
  "checklist": [
    {
      "text": "Confirm current implementation path and target files.",
      "completed": false
    },
    {
      "text": "Implement the behavior change.",
      "completed": false
    },
    {
      "text": "Run targeted verification.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Small bounded bug with clear target files. Start with GPT-5.4 Mini and escalate only if flow is unclear.",
  "acceptanceCriteria": "- Expected behavior happens.
- Existing behavior outside scope is not regressed.",
  "verification": "- Reproduce original flow.
- Verify expected result.
- Run targeted test/build if available.",
  "repoContext": "Repo: q-chang/buddy-android
Area: <feature area>
Relevant files:
- <full path>",
  "jiraKey": "QCA-xxxx",
  "repo": "https://github.com/q-chang/buddy-android",
  "sourceUrl": ""
}
```

## Parallel Parent Template

Parent is the foundation, merge, and review owner.

```json
{
  "projectId": "project-id",
  "title": "[QCA-xxxx][Android] Foundation, merge, and review for <feature>",
  "description": "Define shared foundation and review/merge child feature slices for <feature>.",
  "status": "backlog",
  "priority": "medium",
  "branch": "feature/qca-xxxx-foundation",
  "tags": ["QCA-xxxx", "Android", "Foundation", "Parallel"],
  "targetFiles": [
    "JobDetailInfoTab.kt",
    "shared/AttachmentPreviewContract.kt (new, if needed)"
  ],
  "checklist": [
    {
      "text": "Confirm shared package/directory structure for child tasks.",
      "completed": false
    },
    {
      "text": "Define navigation/action contract for child pages.",
      "completed": false
    },
    {
      "text": "Define shared attachment preview/open/share strategy.",
      "completed": false
    },
    {
      "text": "Review and merge child branches back into the foundation branch.",
      "completed": false
    },
    {
      "text": "Run final integration verification after children are merged.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "Parent owns foundation, shared contracts, merge/review, and final integration. Use GPT-5.4 because child branches depend on this contract.",
  "acceptanceCriteria": "- Shared contracts are clear for child tasks.
- Child branches can implement independently without duplicate navigation/preview infrastructure.
- Final merged flow passes integration verification.",
  "verification": "- Inspect child branches before merge.
- Check for duplicate preview/navigation implementations.
- Run full manual flow after merge.",
  "repoContext": "Repo: q-chang/buddy-android
Area: <feature area>

This parent is the source of truth for shared contracts. Do not send agents back to Jira.",
  "jiraKey": "QCA-xxxx",
  "repo": "https://github.com/q-chang/buddy-android",
  "sourceUrl": ""
}
```

## Parallel Child Template

```json
{
  "projectId": "project-id",
  "parentId": "parent-task-id",
  "title": "Create Site Info detail page with customer attachments",
  "description": "Create one feature slice under the parent foundation branch.",
  "status": "backlog",
  "priority": "medium",
  "branch": "feature/qca-xxxx-foundation/site-info-page",
  "tags": ["QCA-xxxx", "Android", "Site Info"],
  "targetFiles": [
    "site_info/JobSiteInfoRoute.kt (new)",
    "site_info/JobSiteInfoScreen.kt (new)",
    "JobDetailSiteInfoSection.kt"
  ],
  "checklist": [
    {
      "text": "Branch from the parent foundation branch.",
      "completed": false
    },
    {
      "text": "Use the navigation and preview/open/share contract defined by the parent task.",
      "completed": false
    },
    {
      "text": "Implement only this feature slice and avoid touching unrelated child-task files.",
      "completed": false
    },
    {
      "text": "Prepare notes for parent merge/review.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "New page with navigation and attachment preview/share behavior. GPT-5.4 is safer than Mini.",
  "acceptanceCriteria": "- Page opens from the expected entry point.
- Required fields render correctly.
- Empty states are handled.
- Shared preview/open/share behavior is reused.",
  "verification": "- Open parent flow.
- Navigate to this page.
- Verify normal, empty, and attachment cases.
- Return to parent screen.",
  "repoContext": "Create new files under:
app/src/main/java/.../<feature_package>/

Use shared contract from parent. Do not create duplicate infrastructure.",
  "jiraKey": "QCA-xxxx",
  "repo": "https://github.com/q-chang/buddy-android",
  "sourceUrl": ""
}
```

## Example: Token-Saving Parallel Split

For a Codex parallel task like QCA-3242:

```json
{
  "parent_foundation_merge_review": {
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "high"
  },
  "child_details_tab_layout": {
    "agent": "Codex",
    "model": "GPT-5.4 Mini",
    "effort": "medium"
  },
  "child_site_info_page": {
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "high"
  },
  "child_documents_page": {
    "agent": "Codex",
    "model": "GPT-5.4",
    "effort": "high"
  }
}
```

Rationale:

- Parent needs stronger model for foundation and merge/review.
- Existing layout slice can use Mini if entry points and contract are clear.
- New pages with navigation/preview/share should not start on Mini.
