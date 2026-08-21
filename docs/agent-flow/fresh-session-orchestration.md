# Codex Copy Prompt and Legacy Fresh-Session Orchestration

## Current Copy Prompt contract

The card **Copy Prompt** action is a Codex handoff. It is not the managed ChatGPT/@devflowz execution path and it is not an engine selector.

1. The user clicks **Copy for Codex** on a DevFlow card.
2. DevFlow renders the `codex` prompt pipeline from authoritative card data.
3. The user pastes that prompt into Codex.
4. Codex independently investigates the repository, reads repository-native instructions, plans, edits files, runs shell commands/tests/builds, uses native Git, creates commits when appropriate, and decides when the repository task is complete.
5. If available, Codex may call `update_external_task_status` to synchronize the DevFlow card. That synchronization is advisory only.

A live DevFlow connection is not required after the prompt has been copied. If board synchronization is unavailable or fails, Codex continues repository work. A status-sync failure must not cause rollback, repeated verification, abandonment of a valid commit, or rerouting repository execution through DevFlow.

## Prompt authority and isolation

The production Copy Prompt source is the `codex` pipeline in `config/prompt-pipeline.json` and its `skills/prompt.codex-*.md` sections. The rendered task context contains card-authored implementation information such as title, description, reasoning, acceptance criteria, checklist, verification guidance, target files, repository context, references, and bounded design/image evidence when present.

The current Codex Copy Prompt must **not** auto-inject execution state or project-local DevFlow policy. In particular it does not inject:

- `.devflow/agents.md` or root/project DevFlow instruction overlays,
- `.devflow/prompt-overrides/*`,
- active/latest agent-run identity,
- managed workspace paths or workspace authority,
- claim/ownership epoch or lifecycle state,
- managed verification/finalization requirements,
- DevFlow repository read/edit/command requirements that are not card-authored task data.

This isolation is deliberate: DevFlow authors the task and may mirror board status; Codex owns repository execution after handoff.

## ChatGPT/@devflowz remains managed

ChatGPT/@devflowz execution is a separate first-class workflow. It may use DevFlow claims, managed workspaces, execution ownership, verification freshness, task-owned commits, integration, finalization, recovery, and board-loop policy. The Codex Copy Prompt path does not weaken or replace those controls, and managed execution controls do not become prerequisites for Codex repository work.

## Completion

For Codex Copy Prompt, repository completion is judged by Codex from the task requirements and the verification it performs in the repository. `update_external_task_status` may report `in-progress`, `ready-for-review`, or `done`, including informational summary/commit/verification metadata, but those fields do not become authoritative DevFlow Git or verification evidence.

For ChatGPT/@devflowz managed execution, completion continues to follow the managed lifecycle and finalization contract.

## Historical auto-launch behavior

Older DevFlow builds included fresh-process agent launchers, managed Codex workspaces, agent-run callbacks, auto-work continuation, CLI-specific launch flags, and prompt files generated per run. Those paths may remain for compatibility or separate Auto Work features, but they are **historical/non-authoritative for the current card Copy Prompt**. Do not copy their managed-workspace or finalization requirements into the Codex handoff prompt.
