# DevFlow Lean Examples

These examples are optional illustrations. They do not define policy or structural schema; use the router, canonical specialist skill, and live tool schema for authoritative guidance.

## Ordinary implementation-ready card example

```json
{
  "projectName": "dev-flow",
  "title": "Fix stale loading state after failed save",
  "description": "Clear the editor loading state when save fails through either the local validation path or service-error path. Preserve the current success behavior and retry action.",
  "status": "backlog",
  "priority": "high",
  "category": "frontend",
  "targetFiles": [
    "src/components/EditorPanel.tsx",
    "tests/components/EditorPanel.test.tsx"
  ],
  "checklist": [
    {
      "id": "loading-test",
      "text": "Add regression coverage for local and service-error terminal paths.",
      "completed": false
    },
    {
      "id": "loading-fix",
      "text": "Clear loading state on every failed save terminal path without changing success behavior.",
      "completed": false
    }
  ],
  "acceptanceCriteria": "- Successful save keeps current behavior.\n- Local validation failure clears loading.\n- Service failure clears loading and keeps retry available.\n- A stale response cannot restore loading after a newer terminal state.",
  "verification": "- Run focused editor save-state tests.\n- Verify success, validation failure, service failure, retry, and stale-response cases.",
  "repoContext": "Implementation map:\n- File: src/components/EditorPanel.tsx\n  Class/function: save handler and terminal-state update\n  Current behavior: one failure branch can leave loading true.\n  Expected change: every terminal failure clears loading while preserving success/retry semantics."
}
```

## Embedded task defect example

Use an embedded bug thread when a defect belongs to an existing task rather than creating unrelated top-level work.

```json
{
  "taskId": "DVF-0301",
  "title": "Save remains loading after service failure",
  "source": "review",
  "severity": "high",
  "actual": "A 503 response reaches the shared service-error path but the editor stays in loading state.",
  "expected": "Every terminal save failure clears loading and leaves the retry action usable.",
  "evidence": "Review of the service-error branch and focused regression test.",
  "relatedAreas": ["EditorPanel", "save request wrapper"],
  "prompt": "Fix the service-error terminal path inside the existing task. Preserve success behavior and local-validation handling; add focused regression coverage.",
  "createdBy": "ChatGPT",
  "responseMode": "summary"
}
```

The corresponding action is `open_task_bug` on the existing task.

## Parent with parallel children example

```text
Parent:
- Outcome: add searchable task history with a stable query contract.
- Owns: shared contract, dependency graph, final combined verification.
- Status: backlog.

Backend child:
- Owns: query parsing, repository filtering, backend tests.
- Target scope: server query/repository files.
- Can run in parallel after the shared query contract is fixed.

Frontend child:
- Owns: search input, result state, UI tests.
- Target scope: task-history UI files.
- Can run in parallel against the shared query contract.

Migration child, only if required:
- Owns: schema/index migration and migration tests.
- If query behavior depends on the new index/schema, declare this child as the explicit prerequisite instead of serializing unrelated siblings.
```

## Semantic field-placement example

```text
description:
Show archived tasks when the user enables Include archived. Keep the default view unchanged.

repoContext:
Implementation map:
- File: src/server/routes/tasks.ts
  Class/function: task-list query parsing
  Current behavior: archived rows are always excluded.
  Expected change: include them only when the request explicitly enables the option.

targetFiles:
- src/server/routes/tasks.ts
- tests/server/taskListQuery.test.ts

acceptanceCriteria:
- Default task list still excludes archived tasks.
- Include archived returns active and archived matches.
- Invalid option values use the existing validation/error behavior.

verification:
- Run focused task-list query tests for default, enabled, and invalid-option cases.
```

## Source-evidence example

```text
Desired requirement:
- Latest approved product clarification says the new control is hidden until the feature is available.
- Approved design shows the hidden state and copy for the available state.

Implementation evidence:
- Current repository renders the control disabled at all times.
- The existing availability selector is in FeatureActions.tsx.

Implementation delta:
- Change current disabled rendering to the approved hidden/available behavior.
- Do not treat the existing disabled behavior as a reason to override the approved requirement.
```

## Execution handoff example

```text
Existing task implementation:
1. Establish the task claim and use its managed workspace.
2. Read the bounded current implementation and nearest tests.
3. Add focused regression proof for the changed behavior.
4. Apply guarded edits and run the risk-appropriate verification.
5. Commit only task-owned changes.
6. Prefer the task finalization flow when the workspace is clean and verified; preserve the workspace for recovery if finalization cannot prove safety.
```

## Blocked preparation card example

```json
{
  "projectName": "dev-flow",
  "title": "Clarify missing export format contract",
  "description": "Preserve the export request without guessing file structure or compatibility behavior. The required output format is not yet defined by current product evidence.",
  "status": "backlog",
  "priority": "medium",
  "category": "general",
  "targetFiles": [],
  "checklist": [
    {
      "id": "obtain-contract",
      "text": "Obtain the approved export format, sample, or product decision needed to define implementation scope.",
      "completed": false
    },
    {
      "id": "author-map",
      "text": "After the contract is known, update the card with a bounded implementation map and verification plan.",
      "completed": false
    }
  ],
  "acceptanceCriteria": "- Missing product decision is explicit.\n- No implementation details are invented before the export contract is known.",
  "verification": "- Confirm the approved export contract is available before converting this into implementation work.",
  "repoContext": "Current repository evidence is insufficient to select a safe implementation target until the output contract is defined."
}
```
