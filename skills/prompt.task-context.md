## Task Source

Load full task details from the local DevFlow HTTP API when needed.

Recommended API calls:
- `GET /api/tasks/{{task.displayId}}/agent-context?mode=agent-context` for implementation context
- `GET /api/tasks/{{task.displayId}}?mode=full` for full card fields/checklist
- `GET /api/tasks/{{task.displayId}}/prompt?mode=standard` only when previewing prompt rendering

{{task.imagesApi}}

Use MCP only when HTTP API access is unavailable. Do not assume missing details; fetch them.

Fetch checklist details from DevFlow before reporting completion. Complete or explicitly explain every required item on the current card.

Fetch checklist details from DevFlow before reporting completion. Complete or explicitly explain every required item on the current card.
