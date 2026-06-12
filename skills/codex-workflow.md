# Codex Workflow

## Purpose

This file defines how DevFlow should launch and manage Codex tasks.

Use this file for Codex-specific behavior only. Do not duplicate the central task prompt template here.

## When to Use

Use this workflow when a task is assigned to:

```text
agent: Codex
```

## Launch Mode

Use interactive top-level Codex mode when Codex App/history visibility is required.

Known verified behavior:

- Use `codex`.
- Use `-C` / `--cd` for local project root.
- Use `-m` / `--model`.
- Use `-a never` for no approval prompts.
- Use `-s danger-full-access` for full workspace access.
- Alternative dangerous mode: `--dangerously-bypass-approvals-and-sandbox`.
- Do not use `codex exec` for app-history mode unless verified that exec history appears in Codex App.
- No verified direct reasoning effort flag from the current help output, so effort should be prompt/config fallback until confirmed.

## Command Behavior

DevFlow should launch Codex from the task project local path by using `-C` / `--cd`.

Conceptual command shape:

```bash
codex -C <LOCAL_PATH> -m <MODEL> -a never -s danger-full-access
```

Alternative dangerous mode, if configured:

```bash
codex -C <LOCAL_PATH> -m <MODEL> --dangerously-bypass-approvals-and-sandbox
```

The final task prompt should be built from:

```text
skills/agent-task-prompt-template.md
```

Then the final prompt should be passed into the Codex session according to the supported local runner behavior.

## App-history Mode

For Codex App/history mode:

- Prefer interactive top-level Codex mode.
- Do not use `codex exec` unless verified that the execution appears in Codex App history.
- Log that app-history mode was requested.
- If future Codex CLI versions expose a confirmed history/session flag, update this workflow after checking `codex --help`.

## Permission and Sandbox Behavior

For no approval prompts:

```text
-a never
```

For full workspace access:

```text
-s danger-full-access
```

Alternative dangerous mode:

```text
--dangerously-bypass-approvals-and-sandbox
```

Use dangerous permission/sandbox behavior only when DevFlow configuration allows it.

If dangerous mode is disabled by configuration, DevFlow should not silently add it.

## Reasoning Effort

Current verified Codex CLI help does not confirm a direct reasoning effort flag for this workflow.

Until a real flag is confirmed:

- Put effort into the prompt as fallback.
- Use config fallback if DevFlow has a supported Codex config mechanism.
- Log effort handling as `prompt_fallback` or `config_fallback`.
- Do not invent a CLI flag for effort.

Example prompt fallback:

```text
Reasoning Effort: {task.effort}
```

## Logging

Write a separate Codex run log.

Log at minimum:

- runId
- taskId
- projectId
- project name if available
- localPath
- branch
- model
- effort
- effort handling mode
- command executable
- command args without secrets
- start time
- end time
- exit code if available
- whether app-history mode was requested
- approval mode
- sandbox mode

Do not leak secrets.

Do not log API keys, tokens, `.env` content, cookies, or credential files.

## Optional Exec / Headless Mode

`codex exec` may be supported later for headless automation.

Do not use `codex exec` for app-history mode until verified.

If DevFlow adds a separate headless mode later, document it separately from app-history mode.

## Failure Handling

If `codex` is not found:

- Mark the run as failed.
- Tell the user Codex CLI is not available on PATH.
- Do not fallback to another agent unless explicitly configured.

If the local path is missing:

- Mark the run as failed.
- Do not launch from the wrong directory.

If model is missing:

- Use the task model if available.
- Otherwise use the configured Codex default model.
- Log which fallback was used.

## Non-goals

This file must not define the central task wording.

This file must not define Antigravity or Claude behavior.
