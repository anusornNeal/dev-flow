# Dev Flow Card Schema and Writing Rules

## Purpose

This document defines how to write Dev Flow cards and what JSON fields/values should be sent to `Dev_Flow.create_task` or `Dev_Flow.update_task`.

It combines card-writing rules, schema reference, allowed values, and examples.

## Raw API vs MCP Convenience Inputs

DevFlow exposes two interfaces for creating tasks. They accept slightly different project identifiers:

| Interface | Project field | Notes |
|---|---|---|
| Raw API (`POST /api/tasks`) | `projectId` (required) | Must send the internal project UUID. |
| MCP tool (`Dev_Flow.create_task`) | `projectId`, `projectName`, `repo`, `repoUrl`, or `localPath` | The MCP layer resolves whichever identifier you provide into a `projectId`. Only one is needed. Prefer `projectName` or `repo` for readability. |

All other task fields are identical across both interfaces.

## Current Task Schema

**Core Rule**: The card is the single source of truth. It must be detailed enough to complete the work without relying on Jira, spec pages, or external links. Do not dump prompt-template guidance into the card; use `checklist` for executable work logic.

### Required fields

| Field | Type | Notes |
|---|---|---|
| `title` | string | Concise implementation title. |
| `projectId` | string | Required for raw API. MCP can resolve from convenience fields. |

### Optional fields

```json
{
  "description": "string (Markdown)",
  "status": "backlog | todo | in-progress | ready-for-review | done",
  "priority": "low | medium | high",
  "branch": "string",
  "tags": ["general"],
  "targetFiles": ["string"],
  "checklist": [
    {
      "id": "string (stable, required)",
      "text": "string (required)",
      "completed": false
    }
  ],
  "effort": "string (depends on agent/model pair)",
  "model": "string (see model enum)",
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
  "designImages": ["string (URL or base64)"],
  "specUrl": "string",
  "jiraKey": "string",
  "repo": "string",
  "sourceUrl": "string"
}
```

> **Note:** `images` is the attachment array for new task cards. `designImages` remains the array form for design references, and legacy `designImage` input is accepted only for backward compatibility.

Always confirm the latest schema with:

```text
Dev_Flow.get_schema
```

### tags

```json
["frontend", "backend", "general"]
```

Rules:
- `tags` is only for task type classification.
- Allowed values are exactly `frontend`, `backend`, and `general`.
- Use `frontend` for UI/client work, `backend` for server/infrastructure work, and `general` for cross-cutting or non-layer-specific work.
- Do not put Jira keys, labels, platforms, bug types, or component names in `tags`. Put those in `title`, `description`, `jiraKey`, or `repoContext` instead.

## Allowed Values

### status

```json
["backlog", "todo", "in-progress", "ready-for-review", "done"]
```

Default: `backlog`

### priority

```json
["low", "medium", "high"]
```

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

### effort

Effort values are **not universal**. They depend strictly on the selected agent/model pair. The API will reject invalid combinations and list valid values in the error message.

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

**Practical rule for card authoring:** Use `low`, `medium`, `high`, or `xhigh` through DevFlow tools. Do not use `none`, `minimal`, or `max` unless you are targeting a specific model that supports them. The stored schema accepts a wider range (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`) for backward compatibility, but authoring tools will validate against the model's actual capabilities.

Do not use old values like `small`, `large`, or `M`.

## Agent/Model Mapping

| Agent | Valid models |
|---|---|
| Codex | GPT-5.4 Mini, GPT-5.4, GPT-5.5 |
| Antigravity | Gemini 3.5 Flash, Gemini 3.1 Pro |
| Claude | Claude 4.6 Sonnet, Claude 4.6 Opus, Claude 4.7 Opus, Claude 4.8 Opus |

Invalid examples:

```json
{ "agent": "Antigravity", "model": "GPT-5.4" }
```

```json
{ "agent": "Codex", "model": "Gemini 3.1 Pro" }
```

## Field Usage Rules

### branch

The `branch` field is the first-class field for tracking the working branch.

```json
{
  "branch": "feature/dvf-0042-add-export-button"
}
```

Rules:
- Always use `task.branch` for active branch metadata.
- Do not embed branch metadata into `description` (e.g. `ACTIVE BRANCH: ...`). The UI renders `task.branch` directly.

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

Do not duplicate Jira summary, implementation checklist, acceptance criteria, or verification here. Use the dedicated fields instead.

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

### checklist

All checklist items **must** include `id`, `text`, and `completed`:

```json
[
  {
    "id": "step-1",
    "text": "Create the Site Info route and screen under the agreed site_info package.",
    "completed": false
  },
  {
    "id": "step-2",
    "text": "Wire the Details tab Site Info entry point to the new route.",
    "completed": false
  }
]
```

Rules:
- `id` must be stable and unique within the checklist.
- `text` must be action-oriented.
- `completed` starts as `false` unless intentionally seeded with done steps.
- Checklist items without `id` will be rejected by the schema.

Bad (missing `id`):

```json
[
  { "text": "Fix bug", "completed": false },
  { "text": "Make it work", "completed": false }
]
```

### images

Use the array form for uploaded task attachments:

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

Rules:
- Prefer `images` (array of objects) for uploaded task attachments; each item includes `absolutePath` so you can view the file natively.
- Prefer `designImages` (array of strings) for design references in new cards.
- `designImage` is legacy compatibility input only. Do not use it in new examples.
- Do not rely on Jira-authenticated images as the only source.

### designImages

Use the array form for design references:

```json
{
  "designImages": [
    "https://example.com/mockup-v2.png",
    "data:image/png;base64,iVBORw0KGgoAAA..."
  ]
}
```

Rules:
- Prefer `designImages` for design references in new cards.
- Use `images` for uploaded task attachments that belong to the task itself.

### repoContext

Use this for task-specific findings, constraints, current behavior, or risk notes only.

**Rule**: Do not repeat repo URL, local path, or branch metadata here.

Example:

```text
Area: My Jobs / Installation / Job Detail / Compose

Create new files under:
app/src/main/java/com/qchang/buddy/compose/ui/jobs/my_jobs/my_jobs_detail/site_info/

Existing entry points:
- app/src/main/java/.../JobDetailInfoTab.kt
- app/src/main/java/.../JobDetailSiteInfoSection.kt

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

### targetFiles

Use readable file names, not full paths.

Existing files:

```json
["JobDetailInfoTab.kt", "JobDetailSiteInfoSection.kt"]
```

New files should include short directory and `(new)`:

```json
["site_info/JobSiteInfoRoute.kt (new)", "site_info/JobSiteInfoScreen.kt (new)"]
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

### specUrl

Use for a stable external spec if available and accessible.

If it requires auth, summarize the requirements into the card fields instead.

### parentId

Use to link a subtask to its parent task:

```json
"parentId": "task-12345"
```

Rules:
- If `parentId` is provided, the `agent` must match the parent task's agent.
- A task cannot be its own parent.

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

## Sharp Examples

### Example: Bug Fix Card

Using MCP `Dev_Flow.create_task`:

```json
{
  "projectName": "dev-flow",
  "title": "Bug: Duplicate task display ID generated after creating new cards",
  "description": "Two cards show the same displayId because the counter doesn't consider all persisted tasks after migration.",
  "status": "backlog",
  "priority": "high",
  "branch": "fix/dvf-0003-duplicate-display-id",
  "tags": ["backend"],
  "targetFiles": [
    "src/server/repositories/taskRepository.ts",
    "src/db/index.ts"
  ],
  "checklist": [
    {
      "id": "step-1",
      "text": "Inspect counter table and displayId generation logic.",
      "completed": false
    },
    {
      "id": "step-2",
      "text": "Fix counter to consider all task statuses including done and merged.",
      "completed": false
    },
    {
      "id": "step-3",
      "text": "Add unique constraint guard for displayId at insert time.",
      "completed": false
    }
  ],
  "effort": "medium",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "Bounded bug with clear target files and SQL schema. GPT-5.4 is safe for DB logic.",
  "acceptanceCriteria": "- Creating a new task never reuses an existing displayId.\n- displayId is unique across all statuses.\n- Existing tasks are not corrupted.",
  "verification": "- Start DevFlow from migrated state.\n- Create a new task.\n- Verify the new displayId is unique.\n- Restart and create another task.\n- Verify counter continues correctly."
}
```

### Example: Feature Card (Raw API)

Using raw API `POST /api/tasks`:

```json
{
  "projectId": "proj-abc-123",
  "title": "Add dark mode support to DevFlow UI",
  "description": "Implement a dark color scheme toggle for the entire DevFlow frontend.",
  "status": "backlog",
  "priority": "medium",
  "branch": "feature/dvf-0095-dark-mode",
  "tags": ["frontend"],
  "targetFiles": [
    "src/index.css",
    "src/App.tsx",
    "src/components/TaskCard.tsx"
  ],
  "checklist": [
    {
      "id": "dm-1",
      "text": "Define dark mode CSS variables and color tokens.",
      "completed": false
    },
    {
      "id": "dm-2",
      "text": "Add theme toggle to settings or header.",
      "completed": false
    },
    {
      "id": "dm-3",
      "text": "Apply dark mode classes to all major components.",
      "completed": false
    },
    {
      "id": "dm-4",
      "text": "Test all views in both light and dark modes.",
      "completed": false
    }
  ],
  "designImages": [
    "https://example.com/dark-mode-mockup.png"
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "Multiple files across the UI layer. GPT-5.4 for reliable multi-file CSS and component changes.",
  "acceptanceCriteria": "- Dark mode toggle works.\n- All major views render correctly in dark mode.\n- No contrast or readability issues.",
  "verification": "- Toggle dark mode on.\n- Navigate through all main views.\n- Check card, drawer, modal, and settings views.\n- Toggle back to light mode and verify no state leaks."
}
```

### Example: Documentation / Skill Rewrite Card

```json
{
  "projectName": "dev-flow",
  "title": "Rewrite Task JSON Schema skill to match current DevFlow schema",
  "description": "The Task JSON Schema skill has outdated fields and examples. Rewrite it to reflect the current task shape.",
  "status": "todo",
  "priority": "high",
  "branch": "docs/rewrite-task-json-schema-current-devflow",
  "tags": ["general"],
  "targetFiles": [
    "skills/schema.md",
    "src/types.ts"
  ],
  "checklist": [
    {
      "id": "schema-1",
      "text": "Read current schema skill and compare against src/types.ts and constants.",
      "completed": false
    },
    {
      "id": "schema-2",
      "text": "Update all field documentation to match current types.",
      "completed": false
    },
    {
      "id": "schema-3",
      "text": "Keep all design reference examples on designImages arrays only.",
      "completed": false
    },
    {
      "id": "schema-4",
      "text": "Add id field to all checklist examples.",
      "completed": false
    },
    {
      "id": "schema-5",
      "text": "Verify no example uses description-only metadata.",
      "completed": false
    }
  ],
  "effort": "low",
  "model": "GPT-5.4 Mini",
  "agent": "Codex",
  "reasoning": "Pure documentation rewrite with no code logic changes. Mini is sufficient.",
  "acceptanceCriteria": "- Skill matches current DevFlow task fields.\n- All design reference examples use designImages arrays.\n- All checklist examples include id, text, completed.\n- Branch is documented as task.branch.",
  "verification": "- Compare rewritten skill against src/types.ts.\n- Search for stale fields: activeBranch, standalone designImage, checklist without id.\n- Confirm there are no new examples that use singular designImage."
}
```

### Example: Parent Task with Subtasks

Parent (foundation, merge, and review owner):

```json
{
  "projectName": "dev-flow",
  "title": "[QCA-3242][Android] Foundation, merge, and review for Details tab update",
  "description": "Define shared foundation and review/merge child feature slices.",
  "status": "backlog",
  "priority": "medium",
  "branch": "feature/qca-3242-foundation",
  "tags": ["general"],
  "targetFiles": [
    "JobDetailInfoTab.kt",
    "shared/AttachmentPreviewContract.kt (new)"
  ],
  "checklist": [
    {
      "id": "found-1",
      "text": "Confirm shared package/directory structure for child tasks.",
      "completed": false
    },
    {
      "id": "found-2",
      "text": "Define navigation/action contract for child pages.",
      "completed": false
    },
    {
      "id": "found-3",
      "text": "Review and merge child branches back into the foundation branch.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "Parent owns foundation, shared contracts, merge/review, and final integration.",
  "acceptanceCriteria": "- Shared contracts are clear for child tasks.\n- Final merged flow passes integration verification.",
  "verification": "- Inspect child branches before merge.\n- Run full manual flow after merge.",
  "repoContext": "Repo: q-chang/buddy-android\nArea: My Jobs / Installation / Job Detail\n\nThis parent is the source of truth for shared contracts.",
  "jiraKey": "QCA-3242",
  "repo": "https://github.com/q-chang/buddy-android"
}
```

Child (subtask linked to parent):

```json
{
  "projectName": "dev-flow",
  "parentId": "parent-task-id",
  "title": "Create Site Info detail page with customer attachments",
  "description": "Create one feature slice under the parent foundation branch.",
  "status": "backlog",
  "priority": "medium",
  "branch": "feature/qca-3242-foundation/site-info-page",
  "tags": ["frontend"],
  "targetFiles": [
    "site_info/JobSiteInfoRoute.kt (new)",
    "site_info/JobSiteInfoScreen.kt (new)"
  ],
  "checklist": [
    {
      "id": "child-1",
      "text": "Branch from the parent foundation branch.",
      "completed": false
    },
    {
      "id": "child-2",
      "text": "Use the navigation and preview contract defined by the parent task.",
      "completed": false
    },
    {
      "id": "child-3",
      "text": "Implement only this feature slice.",
      "completed": false
    }
  ],
  "effort": "high",
  "model": "GPT-5.4",
  "agent": "Codex",
  "reasoning": "New page with navigation and attachment preview/share behavior. Must match parent's agent.",
  "acceptanceCriteria": "- Page opens from the expected entry point.\n- Required fields render correctly.\n- Shared preview/open/share behavior is reused.",
  "verification": "- Navigate to this page.\n- Verify normal, empty, and attachment cases.\n- Return to parent screen.",
  "repoContext": "Create new files under:\napp/src/main/java/.../site_info/\n\nUse shared contract from parent.",
  "jiraKey": "QCA-3242",
  "repo": "https://github.com/q-chang/buddy-android"
}
```

## Token-Saving Parallel Split

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
  }
}
```

Rationale:

- Parent needs stronger model for foundation and merge/review.
- Existing layout slice can use Mini if entry points and contract are clear.
- New pages with navigation/preview/share should not start on Mini.

## Frontend / Backend Split Rule

When a Jira or spec item contains both frontend and backend work, split it into separate DevFlow cards whenever the work can be separated cleanly. 

**Rule**: Use `general` when frontend and backend cannot be separated cleanly. If you must keep one combined card, explain why in the `reasoning` field.
