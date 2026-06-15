# import_tasks_from_file

Import task patches from a JSON file using `devflow.taskPatch.v1` format.

## MCP Tool

`import_tasks_from_file` — accepts `fileUrl` or `localPath`, validates, and applies or dry-runs.

## API Endpoint

`POST /api/tasks/import-file`

## JSON Format (devflow.taskPatch.v1)

```json
{
  "version": "devflow.taskPatch.v1",
  "defaults": {
    "projectName": "my-project"
  },
  "tasks": [
    {
      "taskId": "BUD-0017",
      "operation": "update",
      "fields": {
        "repoContext": "...",
        "acceptanceCriteria": "..."
      }
    },
    {
      "operation": "create",
      "projectName": "my-project",
      "title": "New task",
      "fields": {
        "description": "...",
        "priority": "high"
      }
    }
  ]
}
```

## Sample dry-run

```json
// Request
{ "localPath": "patches/task-update.json", "mode": "dry-run" }

// Response
{
  "mode": "dry-run",
  "summary": {
    "created": 1,
    "updated": 1,
    "skipped": 0,
    "failed": 0,
    "createdIds": ["New task"],
    "updatedIds": ["BUD-0017"]
  }
}
```

## Sample apply

```json
// Request
{ "localPath": "patches/task-update.json", "mode": "apply" }

// Response
{
  "mode": "apply",
  "summary": {
    "created": 1,
    "updated": 1,
    "skipped": 0,
    "failed": 0,
    "createdIds": ["BUD-0058"],
    "updatedIds": ["BUD-0017"]
  }
}
```

## Security

- `fileUrl` must be `http://` or `https://`, 15s timeout, 5 MB max
- `patchFilePath` must be inside DevFlow project root, no `../` path traversal
- File content is JSON only, no code execution
- `dry-run` validates the entire patch before any mutation
- `apply` validates the entire patch first, then mutates atomically
- Unknown fields return a clear per-operation error; other valid operations still process
