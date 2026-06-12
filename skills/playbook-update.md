# DevFlow Agent Playbook Update

## Purpose

This file defines DevFlow agent execution rules and operating flow.

It explains how agents should pick up tasks, use skills/templates/workflows, handle mini-tasks, and orchestrate subtasks.

## Core Flow

The standard execution flow is:

```text
ready-to-do
→ claim task
→ get_task_for_agent
→ build prompt from central template
→ apply per-agent workflow
→ launch agent from localPath
→ work and verify
→ check completed mini-tasks only after verification
→ move to ready-for-review
```

## Source of Truth

Agents must use agent-ready context as the source of truth.

Agents must not fetch full noisy task data unless needed.

The correct task loading entrypoint is:

```text
get_task_for_agent
```

Do not start implementation from a raw lookup like:

```ts
tasks.find(x => x.displayId === "DEVFLOW-0018")
```

Raw task lookup can miss subtasks, parent context, sibling context, project local path, and orchestration metadata.

## Task Claiming

Before working on a task:

- Confirm the task is eligible to work.
- Claim the task safely.
- Move it to `in-progress` only when work actually starts.
- Record `claimedBy`, `claimedAt`, or `runId` if the run-state fields are implemented.

If the task is already claimed or running, do not start a duplicate run unless explicitly allowed.

## Ready-to-do Automation

Auto-working must only trigger when enabled.

If ready-to-do tasks exist while auto-working is off, turning it on should drain or claim the queue safely.

Queue draining must avoid duplicate claims.

A safe automation loop should:

```text
1. Check whether auto-working is enabled.
2. Find eligible ready-to-do tasks.
3. Claim one task atomically.
4. Build agent-ready context with get_task_for_agent.
5. Launch the correct agent workflow.
6. Record run state.
7. Continue only if queue rules allow more work.
```

## Prompt and Workflow Separation

DevFlow uses two skill categories:

```text
Skills
├─ Prompt Templates
│  └─ Agent Task Prompt Template
│
└─ Agent Workflows
   ├─ Antigravity Workflow
   ├─ Codex Workflow
   └─ Claude Workflow
```

Prompt Template means what the agent must do.

Agent Workflow means how that agent is launched, how permissions are handled, how history is preserved, and how run logging works.

Do not mix these concerns.

## Building the Final Agent Prompt

The prompt builder should:

- Load `skills/agent-task-prompt-template.md`.
- Fill placeholders from `get_task_for_agent`.
- Include task objective, requirements, repo context, target files, acceptance criteria, verification, checklist, and orchestration metadata.
- Include effort in the prompt when the selected agent has no verified effort CLI flag.
- Omit empty sections only when doing so does not hide important task context.

## Applying Agent Workflow

After building the prompt, DevFlow should apply the workflow for the assigned agent:

- `Antigravity` → `skills/antigravity-workflow.md`
- `Codex` → `skills/codex-workflow.md`
- `Claude` → `skills/claude-workflow.md`

The workflow decides launch command behavior, permission behavior, history/app mode, and logging.

## Mini-task / Checklist Rules

Checklist items are mini-tasks inside one card.

Agents must not blindly check all mini-tasks.

Agents may check a mini-task only when:

- The implementation for that item is complete.
- The item was verified directly or indirectly through the task verification steps.
- The completion can be explained in the final notes.

If verification was skipped or failed, leave the checklist item unchecked and write a note.

## Subtask Orchestration Rules

Subtasks are separate task records connected by `parentId`.

A parent task may spawn subtasks using each subtask’s own agent, model, and effort.

When `get_task_for_agent` returns:

```text
orchestration.hasSubtasks = true
```

The agent must start in orchestrator mode.

In orchestrator mode, the agent should:

```text
1. Read the parent objective and constraints.
2. Read all subtasks returned by get_task_for_agent.
3. Identify dependencies between subtasks.
4. Decide which subtasks can run in parallel.
5. Launch or hand off each subtask using its own assigned agent/model/effort.
6. Track subtask status and results.
7. Review outputs.
8. Merge or coordinate final integration if the parent owns integration.
9. Run parent-level verification.
10. Move parent to ready-for-review only after child work and final verification are complete.
```

The parent agent should not implement all child work directly unless explicitly instructed.

## Subtask Implementer Rules

When `get_task_for_agent` returns:

```text
orchestration.isSubtask = true
```

The agent should act as implementer for that subtask.

The agent should:

- Stay inside the subtask scope.
- Use the parent task context for shared contracts.
- Avoid touching unrelated sibling-task files.
- Prepare notes for parent merge/review.
- Verify its own slice before moving to ready-for-review.

## Parent Task Preflight

Before editing files, the agent must know:

```text
- Is this a parent task?
- Does it have subtasks?
- Is this task a subtask?
- What is the recommended mode?
- Which subtasks exist?
- Which agent/model/effort is assigned to each subtask?
```

If the task has subtasks and the agent starts implementing immediately, that is a process failure.

## Ready-for-review Rules

Move a task to `ready-for-review` only when:

- Required implementation is complete.
- Verification has been performed or clearly documented as blocked.
- Completed mini-tasks are checked accurately.
- Final notes include changed files and verification result.

Do not move a parent task to `ready-for-review` while required subtasks are still incomplete unless the parent task explicitly only covers planning or orchestration.

## Logging Rules

Every agent run should log:

- runId
- taskId
- agent
- model
- effort
- project/localPath
- branch
- selected workflow
- command args without secrets
- start time
- end time
- exit status
- verification summary if available

Do not leak secrets.

## Failure Handling

If the assigned agent CLI is missing:

- Mark the run as failed.
- Explain which CLI is missing.
- Do not silently switch agents unless configured.

If `localPath` is missing:

- Do not launch the agent from the wrong directory.
- Mark the run as failed.
- Ask for project local path or update project config.

If the task has unclear scope:

- Do not invent requirements.
- Use the available task context.
- Leave notes about assumptions and unresolved questions.

## Key Rule

If a task can have relationships, always use relationship-aware context.

Agent execution must start from:

```text
get_task_for_agent
```

not from raw task data.
