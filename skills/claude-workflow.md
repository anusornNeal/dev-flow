# Claude Workflow

## Purpose

This file defines how DevFlow should launch and manage Claude tasks.

This file documents optional/legacy Claude CLI launch behavior only. It does not define the manual Copy Prompt; that prompt is engine-agnostic and comes from `config/prompt-pipeline.json`.

## When to Use

Use this workflow when a task is assigned to:

```text
agent: Claude
```

## Important Rule

DevFlow must inspect the actual installed Claude CLI help before defining final flags.

Do not copy Antigravity or Codex flags blindly.

If model, effort, approval, permission, workspace, or history/session flags are not confirmed, DevFlow must log a warning and fallback through prompt/config only.

## Launch Mode

Claude launch behavior is intentionally conservative until verified from the installed CLI.

Before running a Claude task, DevFlow should inspect:

```bash
claude --help
```

If additional subcommands exist, inspect those too before relying on them.

## Command Behavior

The process cwd should be the managed workspace root resolved internally by DevFlow; do not inject or ask the agent to reconstruct the physical path.

The final task prompt should be built from:

```text
config/prompt-pipeline.json
```

Only use CLI flags that have been verified on the installed Claude CLI.

## Model Handling

If a model flag is confirmed:

- Pass the task model through the confirmed flag.
- Log the model flag used.

If a model flag is not confirmed:

- Put model into prompt/config fallback.
- Log warning: `model flag not confirmed; using fallback`.

## Reasoning Effort

If an effort flag is confirmed:

- Pass task effort through the confirmed flag.
- Log the effort flag used.

If an effort flag is not confirmed:

- Put effort into the prompt/config fallback.
- Log warning: `effort flag not confirmed; using fallback`.

Example prompt fallback:

```text
Reasoning Effort: {task.effort}
```

## Permission and Approval Handling

Do not assume Codex or Antigravity permission flags work for Claude.

If approval/permission flags are confirmed:

- Use only the confirmed flags.
- Log the approval/permission mode.

If not confirmed:

- Do not invent flags.
- Launch with safe defaults.
- Log warning that permission behavior is not confirmed.

## App / Session / History Behavior

Future Claude app/session/history behavior may be added only after verification.

Until then:

- Do not claim app-history support unless verified.
- Log whether session/history behavior is supported or unknown.

## Logging

Write a separate Claude run log.

Log at minimum:

- runId
- taskId
- projectId
- project name if available
- workspaceId (preferred); include a resolved cwd only in internal diagnostics when strictly needed, never in the task prompt
- branch
- model
- model handling mode
- effort
- effort handling mode
- command executable
- command args without secrets
- start time
- end time
- exit code if available
- help inspection result or timestamp
- warnings for unconfirmed flags

Do not leak secrets.

Do not log API keys, tokens, `.env` content, cookies, or credential files.

## Failure Handling

If `claude` is not found:

- Mark the run as failed.
- Tell the user Claude CLI is not available on PATH.
- Do not fallback to another agent unless explicitly configured.

If DevFlow cannot resolve the managed workspace root internally:

- Mark the run as failed.
- Do not guess, derive, or launch from another directory.

If required flags are not confirmed:

- Use prompt/config fallback only when safe.
- Log the fallback.

## Non-goals

This file must not define the central task wording.

This file must not define Antigravity or Codex behavior.
