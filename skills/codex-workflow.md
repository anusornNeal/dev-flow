# Codex Workflow

## Current Copy Prompt contract

The card **Copy for Codex** action is an autonomous repository handoff. DevFlow supplies authoritative card-authored task information; after the prompt is copied, Codex owns repository investigation, planning, edits, shell commands, tests/builds, native Git workflow, commits, and completion judgment.

A live DevFlow connection is not required. Codex must not treat DevFlow as its repository execution layer and must not require DevFlow reads/edits/commands in place of native repository tools.

The current Copy Prompt comes from the `codex` pipeline in `config/prompt-pipeline.json`. It intentionally does not auto-inject `.devflow/agents.md`, project-local prompt overrides, active/latest run identity, managed workspace context, claim/lifecycle authority, or managed finalization instructions.

## Board synchronization

When available, `update_external_task_status` may be used to mirror progress to `in-progress`, `ready-for-review`, or `done`. This is best-effort presentation synchronization, not an execution lifecycle.

If status synchronization is unavailable or fails:

- continue repository investigation and implementation;
- do not roll back correct work;
- do not re-run verification solely because board sync failed;
- do not abandon or invalidate a valid commit;
- do not reroute repository execution through DevFlow;
- report the board-sync failure separately from repository-task completion.

External summary/commit/verification fields are informational only and do not become authoritative DevFlow execution, Git, or verification evidence.

## ChatGPT/@devflowz distinction

ChatGPT/@devflowz is a separate managed workflow that may require DevFlow claims, managed workspaces, ownership fencing, verification freshness, task-owned commits, integration, finalization, and recovery. The Codex Copy Prompt path neither replaces nor weakens that managed path; managed controls likewise are not prerequisites for Codex repository work after handoff.

## Optional/legacy DevFlow-launched Codex CLI behavior

The remainder of this file documents launch-specific compatibility behavior only. It is not authority for the card Copy Prompt.

For older or explicit DevFlow-managed Codex launches, interactive top-level Codex mode may be used when Codex App/history visibility is required. Historically verified flags include `-C`/`--cd` for cwd, `-m`/`--model`, `-a never`, and configured sandbox modes. DevFlow-managed launchers may resolve an internal managed workspace cwd and maintain run logs.

Those launch-specific details must stay isolated from the current Copy Prompt. In particular, do not copy managed workspace cwd, run identity, approval/sandbox configuration, lifecycle completion callbacks, or DevFlow finalization requirements into the autonomous handoff prompt.

`codex exec` or other headless/CLI modes may be maintained as explicit launcher features when separately verified. CLI capability assumptions should be checked against the installed Codex version rather than invented.

## Failure handling for legacy launchers

A DevFlow-launched Codex process may fail because the CLI is missing, launch configuration is invalid, or a managed launch workspace cannot be resolved. Those are launcher failures. They do not redefine the semantics of a prompt that has already been copied manually to an independently running Codex session.

Do not leak secrets in launcher logs or prompts.
