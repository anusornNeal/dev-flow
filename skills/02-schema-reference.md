# DevFlow Schema Reference

## Purpose

Reference for DevFlow task fields used by create/update tools.

Confirm live schema with `Dev_Flow.get_schema` when available.

## Authoring helper tools

Use these before writing implementation-ready cards:

- `get_repo_inspection_index`: cached repo index for likely files, classes, composables, functions, routes, mappers, helpers, and tests. Use screen names, visible strings, Jira terms, or flow names as the query before broad file search.
- `validate_task_quality`: preflight the card before `create_task` or `update_task`. It blocks implementation-ready cards that still depend on Jira/source links, lack focused `targetFiles`, or lack an `Implementation map` in `repoContext`.

## Required fields

Raw API requires:

```json
{
  "projectId": "string",
  "title": "string"
}
```

MCP tools may resolve project by one of:

```json
{
  "projectId": "string",
  "projectName": "string",
  "repo": "string",
  "repoUrl": "string",
  "localPath": "string"
}
```

Use only one project identifier when possible.

## Core task shape

```json
{
  "title": "string",
  "description": "string",
  "status": "backlog | todo | in-progress | ready-for-review | done",
  "priority": "low | medium | high",
  "branch": "string",
  "category": "frontend | backend | general",
  "tags": ["string"],
  "targetFiles": ["string"],
  "checklist": [
    {
      "id": "stable-id",
      "text": "action-oriented step",
      "completed": false
    }
  ],
  "effort": "model-specific effort",
  "model": "model name",
  "agent": "Codex | Antigravity | Claude",
  "parentId": "string",
  "reasoning": "string",
  "acceptanceCriteria": "string",
  "verification": "string",
  "repoContext": "string",
  "images": [
    {
      "id": "string",
      "filename": "string",
      "url": "string",
      "absolutePath": "string"
    }
  ],
  "designImages": ["string"],
  "specUrl": "string",
  "jiraKey": "string",
  "repo": "string",
  "sourceUrl": "string"
}
```

## Allowed values

### status

```json
["backlog", "todo", "in-progress", "ready-for-review", "done"]
```

Default: `backlog`

### priority

```json
["low", "medium", "high"]
```

### category

```json
["frontend", "backend", "general"]
```

Use:
- `frontend` for UI/client work,
- `backend` for server/infrastructure work,
- `general` for cross-cutting, docs, orchestration, or work that cannot be cleanly separated.

Do not put `frontend`, `backend`, or `general` in tags.

### agent

```json
["Codex", "Antigravity", "Claude"]
```

Use exact casing.

### model

Common supported model names:

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

Use exact schema spelling.

### model mapping

| Agent | Valid models |
|---|---|
| Codex | GPT-5.4 Mini, GPT-5.4, GPT-5.5 |
| Antigravity | Gemini 3.5 Flash, Gemini 3.1 Pro |
| Claude | Claude 4.6 Sonnet, Claude 4.6 Opus, Claude 4.7 Opus, Claude 4.8 Opus |

### effort

Effort depends on selected agent/model pair.

Known guidance:

| Agent | Model | Available efforts |
|---|---|---|
| Codex | GPT-5.5 | low, medium, high, xhigh |
| Codex | GPT-5.4 | low, medium, high, xhigh |
| Codex | GPT-5.4 Mini | low, medium, high, xhigh |
| Antigravity | Gemini 3.5 Flash | low, medium, high |
| Antigravity | Gemini 3.1 Pro | low, high |
| Claude | Claude 4.8 Opus | low, medium, high, xhigh, max |
| Claude | Claude 4.7 Opus | low, medium, high, xhigh, max |
| Claude | Claude 4.6 Opus | low, medium, high, max |
| Claude | Claude 4.6 Sonnet | low, medium, high, max |

Practical authoring rule:
- Use `low`, `medium`, `high`, or `xhigh` for most DevFlow cards.
- Do not use `none`, `minimal`, or `max` unless the selected model supports it and the tool confirms it.
- Do not use old values like `small`, `large`, or `M`.

## Field rules

### branch

Use first-class `branch` field. Do not embed branch metadata in description.

```json
{
  "branch": "feature/dvf-0042-add-export-button"
}
```

### checklist

Every checklist item must include:

```json
{
  "id": "step-1",
  "text": "Do a concrete action.",
  "completed": false
}
```

Rules:
- `id` is stable and unique within the checklist.
- `text` is action-oriented.
- `completed` starts as `false` unless intentionally seeded complete.
- Items without `id` are invalid.

### targetFiles

Prefer short readable filenames:

```json
["JobDetailViewModel.kt", "JobDetailActionMapping.kt"]
```

Use partial paths only for disambiguation or new files:

```json
["site_info/JobSiteInfoRoute.kt (new)", "site_info/JobSiteInfoScreen.kt (new)"]
```

Full paths belong in `repoContext`.

For `todo`, `in-progress`, and `ready-for-review` cards, `targetFiles` must be focused and must match the `Implementation map` in `repoContext`.

### repoContext

For implementation-ready cards, include an implementation map:

```text
Implementation map:
- File: JobDetailScreen.kt
  Class/function: JobDetailContent / DetailsTabContent
  Current behavior: lower content can render under the Android navigation bar.
  Expected change: apply bottom system-bar padding for Details tab content.
```

### images

Use for uploaded task attachments:

```json
{
  "images": [
    {
      "id": "img-123",
      "filename": "mockup-v2.png",
      "url": "/api/static/images/mockup-v2.png",
      "absolutePath": "C:/Users/.../images/mockup-v2.png"
    }
  ]
}
```

### designImages

Use for design references:

```json
{
  "designImages": [
    "https://example.com/mockup-v2.png",
    "data:image/png;base64,..."
  ]
}
```

Do not use legacy singular `designImage` in new examples.

### jiraKey

Use for Jira traceability:

```json
{
  "jiraKey": "QCA-3242"
}
```

For merged work, use primary Jira key here if only one value is supported, and put all keys in title/description.

### sourceUrl

Leave empty by default. Do not make the agent depend on private Jira/spec links.

### specUrl

Use only for stable accessible specs. If auth is required, summarize the spec into the task fields.

### parentId

Use to link child task to parent:

```json
{
  "parentId": "task-12345"
}
```

Rules:
- child `agent` should match parent `agent` if DevFlow requires it,
- task cannot be its own parent.

## Priority mapping

| Jira Priority | DevFlow priority |
|---|---|
| Highest/Critical | high |
| High | high |
| Medium | medium |
| Low | low |
| Lowest | low |

If missing, infer from user impact and explain in `reasoning`.

## Effort guidance

| Effort | Use when |
|---|---|
| low | one file, text/config/link/simple bug |
| medium | bounded UI/state change, existing patterns clear |
| high | new screen, navigation, preview/share, multiple files |
| xhigh | architecture/refactor/multi-module/high uncertainty |

## Minimal JSON template

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-0000] Fix clear behavior name on screen",
  "description": "Describe current behavior, expected behavior, examples, and out-of-scope boundaries.",
  "status": "backlog",
  "priority": "medium",
  "branch": "fix/qca-0000-clear-behavior-name",
  "category": "frontend",
  "tags": ["android"],
  "targetFiles": ["LikelyFile.kt", "LikelyFileTest.kt"],
  "checklist": [
    {
      "id": "step-1",
      "text": "Confirm the affected implementation path and existing tests.",
      "completed": false
    },
    {
      "id": "step-2",
      "text": "Implement the smallest safe behavior change.",
      "completed": false
    },
    {
      "id": "step-3",
      "text": "Add or update targeted regression tests.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Bounded change with clear target files.",
  "acceptanceCriteria": "- Expected behavior passes.\n- Existing related behavior is unchanged.",
  "verification": "- Run targeted test/build command.\n- Manually verify the affected flow.",
  "repoContext": "Summarize concrete repo findings here.",
  "jiraKey": "QCA-0000",
  "repo": "https://github.com/org/repo",
  "sourceUrl": ""
}
```
