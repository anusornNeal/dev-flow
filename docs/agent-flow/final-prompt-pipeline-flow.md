# Codex Copy Prompt Pipeline and Legacy Agent Flow

## Current Codex pipeline

The card **Copy for Codex** action renders the `codex` pipeline from `config/prompt-pipeline.json`:

1. `prompt.codex-header` — establishes DevFlow as the task/card source and Codex as the autonomous repository executor.
2. `prompt.codex-task-context` — inserts the bounded card-authored implementation context rendered by `renderCodexTaskPrompt`.
3. `prompt.codex-execution` — tells Codex to investigate, plan, edit, run commands/tests/builds, and use native Git independently.
4. `prompt.codex-completion` — makes `update_external_task_status` optional best-effort board synchronization and defines the final repository-work report.

The Copy Prompt route is `GET /api/tasks/:id/prompt`. It deliberately renders the Codex pipeline with assignment and managed workspace execution context removed. Project-local DevFlow instructions and prompt overrides are not part of this handoff.

## Boundary

Copy Prompt is Codex-only product behavior. It must not become a generic agent bootstrap and must not require Codex to perform repository reads, edits, commands, verification, Git, or commits through DevFlow.

DevFlow may synchronize card presentation through `update_external_task_status`. That route is not a lifecycle: direct moves to `in-progress`, `ready-for-review`, or `done` are allowed, and synchronization failure is separate from repository-task success or failure.

Informational completion metadata reported through the external status route must not impersonate authoritative DevFlow Git evidence, verification bindings, execution evidence, checklist completion, or bug resolution.

## Managed ChatGPT/@devflowz path

ChatGPT/@devflowz remains governed by the managed execution stack: claim/workspace ownership, lifecycle authority, verification freshness, task-owned commit, integration, finalization, and recovery. Those controls remain valid for managed work and are intentionally separate from the Codex Copy Prompt path.

## Historical fresh-session/runner flow

Older agent-launch and Auto Work flows used runner wrappers, agent-specific launch configuration, managed workspace cwd values, run callbacks, startup sanitization, and DevFlow finalization. Documentation or compatibility code for those paths should be labeled historical or launch-specific. It is not authority for the current Copy Prompt and must not be used to reintroduce managed execution instructions into the Codex handoff.
