# Legacy Fresh-Session Orchestration

> Historical compatibility document. The fresh-session auto-launch workflow described by older versions of DevFlow is not the current manual worker handoff contract.

## Current manual worker flow

The current card workflow is manual:

1. The user clicks Copy Prompt on a DevFlow card.
2. DevFlow renders one compact, engine-agnostic implementation bootstrap.
3. The user pastes that prompt into a DevFlow-connected implementation engine such as Codex, Antigravity, or Claude.
4. The worker reads the named card through the live DevFlow tool surface, establishes or reuses task ownership and its managed workspace, implements only that card, verifies it, commits task-owned changes, and finalizes through DevFlow.

The copied prompt must not grow with the card body. Large description, acceptance criteria, verification, checklist, subtask bodies, repository context, screenshots, or structured UI specs are fetched on demand instead of being serialized into the initial prompt.

## Canonical prompt source

The single production manual-worker prompt is defined by `config/prompt-pipeline.json` and the `skills/prompt.*.md` files listed by that pipeline. The default pipeline is intentionally small:

- `prompt.header`
- `prompt.task-context`
- `prompt.execution-rules`
- `prompt.completion-contract`

`skills/agent-task-prompt-template.md` is a non-authoritative compatibility pointer. Codex, Antigravity, and Claude workflow documents may retain optional/legacy CLI launch notes, but they do not define different task prompts.

Prompt instructions should express DevFlow tool intents rather than hardcoded local HTTP endpoints. The connected worker discovers current operations from DevFlow tool descriptions and live schemas.

## Task context

Workers begin with the task id from the copied prompt and read `get_task` using `mode="agent-context"`. That context keeps current-task implementation requirements while bounding surrounding parent/child, bug, history, and design data.

If Task UI Design Evidence exists, the worker must inspect both the frozen screenshot and the full structured spec before UI implementation. Agent context carries only bounded frozen-evidence references; the full structured spec is fetched from the frozen preview revision on demand. A newer latest preview does not silently replace the task-attached frozen revision.

## Completion

A worker must not declare the card complete after code edits alone. Completion requires the task requirements and required checklist to be handled, verification to be performed, task-owned changes to be committed, and the task to be finalized through DevFlow. Push remains explicit opt-in. If completion cannot be proven, the worker preserves the managed workspace and reports the blocker.

## Historical auto-launch behavior

Older DevFlow builds included fresh-process launchers, agent-run callbacks, auto-work continuation, CLI-specific launch flags, and prompt files generated per run. Those paths may remain for compatibility or migration work, but they are not authoritative for the current Copy Prompt behavior. When maintaining them, do not copy their launch-specific details back into the manual worker prompt.
