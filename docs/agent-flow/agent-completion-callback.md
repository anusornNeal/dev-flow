# Agent Completion Callback

DevFlow exposes one official completion callback for external agents and worker runners:

```http
POST /api/tasks/:id/agent-complete
```

Use this endpoint when a worker has finished execution and needs DevFlow to record the result, settle the active run, and apply the correct task transition.

## Required Header

Every completion callback must include:

```http
x-agent-request: true
```

Without this header, DevFlow rejects the request with `403`.

## Payload

```json
{
  "runId": "run-123",
  "status": "success",
  "summary": "Implemented callback flow",
  "changedFiles": [
    "src/server/routes/tasks.ts",
    "src/components/TaskCard.tsx"
  ],
  "tests": [
    {
      "command": "npm run verify",
      "result": "passed",
      "output": "all assertions passed"
    }
  ],
  "notes": "Ready for review",
  "moveTo": "ready-for-review"
}
```

Fields:

- `runId`: optional explicit run id. If omitted, DevFlow uses the active run for the task.
- `status`: required. One of `success`, `failed`, or `cancelled`.
- `summary`: required human-readable result summary.
- `changedFiles`: optional array of changed file paths.
- `tests`: optional array of test results with `command`, `result`, and optional `output`.
- `notes`: optional extra notes for logs and run history.
- `moveTo`: optional non-`done` target status override. Allowed values are `backlog`, `todo`, `in-progress`, and `ready-for-review`.

## Status Behavior

- `success`: closes the active run as `succeeded` and moves the task to `ready-for-review` by default.
- `failed`: marks the run `failed` and keeps or moves the task to a safe non-complete state.
- `cancelled`: marks the run `cancelled` and does not auto-complete the task.

DevFlow persists the completion summary, changed files, tests, and notes into task logs and run artifacts under `.devflow/runs/<runId>/`.

## Error Cases

- `404`: task id or displayId does not resolve to a task.
- `400`: payload is invalid.
- `403`: `x-agent-request=true` is missing.
- `409`: no active run exists, `runId` does not match the task run, or the referenced run is already settled.

## Legacy Compatibility Path

The legacy runner path remains available for compatibility:

```http
POST /api/tasks/:id/agent-runs/:runId/complete
```

This path is still supported for older runners, but new external workers should use:

```http
POST /api/tasks/:id/agent-complete
```

## Branch Metadata Rule

`ACTIVE BRANCH` is shared TaskCard metadata, not a per-task markdown section.

When a task has a `branch` value, the shared card UI renders:

```text
ACTIVE BRANCH: <branch>
```

Do not add a standalone “Active Branch Requirement” section to individual task descriptions for this behavior.
