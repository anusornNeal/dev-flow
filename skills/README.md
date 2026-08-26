# DevFlow Skills

DevFlow keeps managed ChatGPT/@devflowz execution policy separate from the Codex Copy Prompt so both surfaces remain explicit and authoritative.

## Authoring and managed execution skills

Start with `00-skill-router.md`, then load only the specialist it selects:

- `01-authoring-core.md` — implementation-ready card authoring.
- `02-schema-reference.md` — semantic task-field placement when live schemas are insufficient.
- `03-reviewer-core.md` — review and existing-task defect handling.
- `04-examples.md` — examples only.
- `05-authoring-evidence.md` — Jira/Figma/Atlas/source evidence.
- `06-authoring-decomposition.md` — parent/child boundaries and parallel slices.
- `07-authoring-execution.md` — ChatGPT/@devflowz repository implementation, verification, task-owned commit, and managed workspace lifecycle.
- `08-board-loop-execution.md` — continuous managed board-loop orchestration.

Master skills are authoritative for the managed ChatGPT/@devflowz path. Compatibility files and examples do not override them.

## Current orchestration boundaries

- Reasoning-worker scheduling is project-pinned: `get_next_action` resumes durable work and `claim_next_task` is the atomic ownership boundary.
- Managed execution continuation stays in `executionContinuationService`; safe terminal integration stays in `finalize_task_workspace`. Do not create parallel lifecycle or completion state machines.
- External/local-native agents execute with their own repository harness and report best-effort status through the agent-neutral synchronization contract.
- Agent Office is a monitoring projection over canonical orchestration state; it is not a second writable scheduler.
- Legacy Auto Work and fresh-process launcher routes remain compatibility-only while current callers still depend on them. New skills and features must not add dependencies on that path.

## On-demand guidance skills

DevFlow also keeps repo-owned brainstorming and UI/UX guidance in a namespace separate from the protected authoring masters. These are guidance-only and do not replace managed execution policy or become automatic Codex Copy Prompt content.

## Codex Copy Prompt

The card **Copy for Codex** action is a separate autonomous handoff. Its production source is the `codex` entry in `config/prompt-pipeline.json` plus the `skills/prompt.codex-*.md` sections listed there.

DevFlow supplies the card-authored implementation context. After copying, Codex independently owns repository investigation, repository-native instructions, planning, edits, shell commands, tests/builds, Git workflow, commits, and completion judgment. Codex is not required to call DevFlow for repository reads, edits, commands, verification, or Git operations.

The copied prompt intentionally excludes DevFlow execution-state injection such as `.devflow/agents.md`, project-local prompt overrides, active/latest run identity, managed workspace paths, claims/lifecycle authority, and managed finalization requirements.

`update_external_task_status` is optional best-effort board synchronization only. Its failure or absence must not stop repository work, roll back a valid change, force verification to run again, invalidate a valid commit, or route Codex execution through DevFlow. Report board-sync problems separately from repository-task results.

`agent-task-prompt-template.md` and agent CLI/launcher documents are compatibility or launch-specific references. They do not redefine the current Codex Copy Prompt contract.
