# Schema Update for Agent-ready Execution

## Purpose

This file defines DevFlow schema updates needed to support agent-ready execution.

The goal is to keep card data clean while allowing `get_task_for_agent` to build a complete agent-ready package for implementation agents.

## Core Rule

Do not add unnecessary fields only for prompt wording.

Subtask orchestration should be generated from existing task/subtask data, not manually written into every card.

Keep card data clean. Let `get_task_for_agent` build the agent-ready package.

## Task Identity Fields

Tasks should support:

```ts
id: string
displayId?: string
title: string
description?: string
status: "backlog" | "todo" | "in-progress" | "ready-for-review" | "done"
priority?: "low" | "medium" | "high"
```

`id` is the internal stable identifier.

`displayId` is the human-readable task id such as `DEVFLOW-0018`.

## Assignment Fields

Tasks should support:

```ts
agent?: "Codex" | "Antigravity" | "Claude"
model?: string
effort?: "low" | "medium" | "high" | "xhigh"
branch?: string
```

Use these fields to decide how the agent should be launched.

Do not encode launch flags in task data.

## Project Fields

Projects should support:

```ts
id: string
name: string
repo?: string
localPath?: string
taskIdPrefix?: string
```

`localPath` is required for local agent execution.

`taskIdPrefix` is used for display ids such as `DEVFLOW`.

## Work Fields

Tasks should support:

```ts
targetFiles?: string[]
checklist?: Array<{
  id?: string
  text: string
  completed: boolean
}>
acceptanceCriteria?: string
verification?: string
```

Checklist items are mini-tasks inside the card.

Checklist items are not the same as subtasks.

Do not mark checklist items complete until verification proves they are actually done.

## Context Fields

Tasks should support:

```ts
repoContext?: string
reasoning?: string
sourceUrl?: string
jiraKey?: string
repo?: string
```

Use these fields to give implementation context without forcing the agent to fetch full noisy external data.

## Parent / Subtask Relation

Tasks should support parent/subtask relation through:

```ts
parentId?: string
```

A parent task is any task with one or more children where child `parentId` equals parent `id`.

A subtask is any task with a `parentId`.

Do not rely only on the parent task object to know whether subtasks exist.

When loading a task for execution, DevFlow must query:

```text
children = tasks.filter(task => task.parentId === currentTask.id)
```

If the task is a subtask, DevFlow may query:

```text
parent = tasks.find(task => task.id === currentTask.parentId)
siblings = tasks.filter(task => task.parentId === currentTask.parentId && task.id !== currentTask.id)
```

## Workflow / Run State Fields

If implemented, tasks or runs may support:

```ts
claimedBy?: string
claimedAt?: string
runId?: string
runStatus?: "queued" | "running" | "succeeded" | "failed" | "cancelled"
```

These fields are for safe automation and queue handling.

Do not use them for prompt wording only.

## Agent-ready Context Shape

`get_task_for_agent` should return a clean agent-ready package.

Suggested shape:

```ts
type AgentTaskContext = {
  task: {
    id: string
    displayId?: string
    title: string
    description?: string
    status: string
    priority?: string
    agent?: string
    model?: string
    effort?: string
    branch?: string
    targetFiles?: string[]
    checklist?: ChecklistItem[]
    acceptanceCriteria?: string
    verification?: string
    repoContext?: string
    reasoning?: string
    sourceUrl?: string
    jiraKey?: string
    repo?: string
    parentId?: string
  }
  project?: {
    id: string
    name: string
    repo?: string
    localPath?: string
    taskIdPrefix?: string
  }
  parent?: TaskSummary
  subtasks: TaskSummary[]
  siblings?: TaskSummary[]
  orchestration: {
    isParentTask: boolean
    hasSubtasks: boolean
    isSubtask: boolean
    subtaskCount: number
    recommendedMode: "orchestrator" | "implementer" | "reviewer"
  }
}
```

## Orchestration Rules

If `hasSubtasks` is true:

```text
recommendedMode = "orchestrator"
```

The agent should not implement the parent directly unless explicitly instructed.

If `isSubtask` is true:

```text
recommendedMode = "implementer"
```

The agent should stay inside the subtask scope and avoid unrelated sibling work.

If the task has no parent and no subtasks:

```text
recommendedMode = "implementer"
```

## Checklist vs Subtask

Checklist:

- Lives inside one task.
- Represents mini-tasks / verification steps for that card.
- Has no independent owner, model, status, branch, or agent.

Subtask:

- Is a separate task record.
- Has its own `id`, `status`, `agent`, `model`, `effort`, `branch`, and `targetFiles`.
- Points to the parent through `parentId`.

The UI and agent context should display checklist and subtasks separately.

## Validation Rules

DevFlow should validate:

- A subtask with `parentId` points to an existing task.
- A parent task can be resolved with its children.
- A task assigned to an agent has a compatible model.
- A task intended for local execution has a project `localPath`.
- Checklist item text is not empty.
- Subtask orchestration is generated, not manually duplicated into card text.

## Migration Notes

Existing task cards do not need to manually add orchestration text.

After this schema update, update the task loading path so agents use `get_task_for_agent` instead of reading a raw task with:

```ts
tasks.find(x => x.displayId === "DEVFLOW-0018")
```

The correct pattern is:

```ts
get_task_for_agent("DEVFLOW-0018")
```
