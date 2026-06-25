# Antigravity Workflow

## Purpose

This file defines how DevFlow should launch and manage Antigravity tasks.

Use this file for Antigravity-specific behavior only. Do not duplicate the central task prompt template here.

## When to Use

Use this workflow when a task is assigned to:

```text
agent: Antigravity
```

## Launch Mode

Use Antigravity interactive mode when conversation history must appear in the Antigravity 2.0 App.

Known verified behavior:

- Use `agy`.
- Use `--model`.
- Use `--dangerously-skip-permissions` for Always Allow behavior.
- Use `-i` / `--prompt-interactive` for app-history / interactive session mode.
- Do not use `--print` for app-history mode.
- `agy --help` currently does not expose a verified real reasoning effort flag.

## Command Behavior

DevFlow should launch Antigravity from the task project local path.

Conceptual command shape:

```bash
agy --model <MODEL> --dangerously-skip-permissions -i
```

The process cwd must be:

```text
{project.localPath}
```

The final task prompt should be built from:

```text
skills/agent-task-prompt-template.md
```

Then the final prompt should be passed into the interactive Antigravity session according to the supported local runner behavior.

## App-history Mode

For Antigravity App history mode:

- Use interactive prompt mode.
- Do not use `--print`.
- Prefer a mode that creates or continues a visible app/history session.
- Log that app-history mode was requested.
- If the CLI behavior changes, update this workflow after re-checking `agy --help`.

## Permission Behavior

For Always Allow behavior:

```text
--dangerously-skip-permissions
```

Use this only when DevFlow configuration allows it.

If dangerous permission mode is disabled by configuration, DevFlow should not silently add it.

## Reasoning Effort

Current verified `agy --help` output does not expose a real reasoning effort flag.

Until a real flag is confirmed:

- Put effort into the prompt as fallback.
- Log effort as `prompt_fallback`.
- Do not invent a CLI flag for effort.

Example prompt fallback:

```text
Reasoning Effort: {task.effort}
```

## Logging

Write a separate Antigravity run log.

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
- whether dangerous permission mode was used

Do not leak secrets.

Do not log API keys, tokens, `.env` content, cookies, or credential files.

## Failure Handling

If `agy` is not found:

- Mark the run as failed.
- Tell the user Antigravity CLI is not available on PATH.
- Do not fallback to another agent unless explicitly configured.

If the local path is missing:

- Mark the run as failed.
- Do not launch from the wrong directory.

If model is missing:

- Use the task model if available.
- Otherwise use the configured Antigravity default model.
- Log which fallback was used.

## Non-goals

This file must not define the central task wording.

This file must not define Codex or Claude behavior.
