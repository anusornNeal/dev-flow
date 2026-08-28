# DevFlow Board Loop Execution

## Purpose
Use this skill when the user asks DevFlow to keep taking eligible work from the board, such as `loop board`, `loop tasks`, or equivalent multi-chat worker instructions.

Explicit execution intents `loop board`, `ทำต่อ`, `ปิดงาน`, `ทำให้จบ`, or equivalent keep-working instructions all mean **continue-until-terminal** by default. One such instruction authorizes the worker to keep advancing the requested board or program without waiting for repeated continue messages.

This skill owns board orchestration only. Load `07-authoring-execution` for implementation, edit, test, verification, commit, workspace-terminal, and recovery details.

## Goal
Act as one cooperative board worker. Repeatedly claim one eligible scope, complete its local task loop, refresh the same board, and take another eligible scope until no safe work remains for this worker.

## Continuation invariant
Non-terminal milestones include: tests pass, an accepted/running durable job is still in flight, a child reaches Done while its parent/program or eligible work remains, a clean commit exists, finalization is pending, or cleanup remains. None of these milestones permits ending the board loop or returning control merely to ask the user to continue.

When the exact accepted/running durable job is the current continuation, call `get_tool_job_result` and keep bounded polling until terminal in the same assistant turn whenever the tool surface remains available. Never launch a duplicate job just to make progress.

## Project boundary
At loop start, resolve the intended board/project once and pin its `projectId` as the loop boundary. Every selection read and claim in that loop must remain inside that project. Do not infer or substitute another project from recent work, another chat, task-prefix familiarity, or the presence of runnable work elsewhere. Project switching is allowed only after the user explicitly asks to switch boards/projects.

## Required loop
After a board-loop starts, continuity is DevFlow-owned rather than chat-owned. Start durable intent by calling `claim_next_task` with `boardLoopRequested=true` and optional `requestedTaskId` for a requested parent/program. Automatic selection defaults to `selectionPolicy=todo-only`. Pass `selectionPolicy=include-backlog` only when the user explicitly mentions backlog; generic wording such as `loop board`, `ทำต่อ`, or `ทำทั้งหมด` does not opt in. A fresh agent or worker after a cutoff/reconnect must call `get_next_action` first and resume the returned persisted loop/continuation before selecting unrelated work. Do not reconstruct loop state from chat or prompt memory when DevFlow-owned state exists.

`get_next_action` stays read-only. It may return `confirm-loop-stop` when the pinned project has no eligible work and the persisted requested scope is terminal; call `claim_next_task` once at that mutation boundary to persist terminal loop state. If the requested scope is not terminal, keep the loop active and resolve the returned attention instead of stopping.


1. For ordinary next-card selection, prefer `claim_next_task` with the same pinned `projectId` and this chat's stable session identity. On the first loop claim set `boardLoopRequested=true`; when the user requested a parent/program also pass `requestedTaskId`. Default to `selectionPolicy=todo-only`. Set `selectionPolicy=include-backlog` only for explicit backlog intent. Once a loop is active, reuse its persisted policy and do not try to change it from a later worker.
2. If the user names a specific card, selection is ambiguous, or the fast path is unavailable, fall back only to actionable task collections in the same pinned `projectId`: use bounded `search_tasks` with `mode=minimal` or `mode=summary` and inspect `status=todo` for ordinary automatic next-work selection. Inspect `status=backlog` only when the persisted loop policy is `include-backlog`, or when the user named a backlog card and you will use explicit `claim_task`. Do not use an unfiltered collection, `all=true`, full/debug density, or a `done` collection for ordinary next-work selection. Backlog remaining under `todo-only` does not prevent loop exhaustion.
3. If `claim_task` returns `TASK_ALREADY_CLAIMED`, do not override the owner. Refresh and choose another eligible task.
4. If `claim_task` returns `TASK_SCOPE_CONFLICT`, skip the conflicting card and choose independent work. Allow overlapping scope only when the user explicitly requests coordinated overlap and the collision is understood.
5. If foreign dirty WIP owns a conflicting card, preserve it and choose safe non-overlapping eligible work. Report blocked only when no safe alternate eligible work exists.

6. Use only the managed workspace returned by the successful claim. Load `07-authoring-execution` and implement exactly the claimed scope under its ownership and verification policy.
7. Independent sibling children may run in parallel when target scope is disjoint and no real prerequisite blocks them. A shared parent does not serialize siblings by itself. Treat structured `prerequisiteTaskIds` eligibility from claim APIs as authoritative; after completing a prerequisite, immediately continue the same explicit loop so newly runnable dependents can be selected without manual status churn.
8. Before terminal completion, refresh relevant local base/sibling state so integration does not overwrite newer independent work.
9. After the execution specialist has produced a clean committed workspace and required checks, prefer `finalize_task_workspace` for the terminal task flow. A clean commit or passing verification is not a response boundary; continue through required finalization and cleanup.
10. If finalization reports `needs-recovery`, preserve the workspace. Inspect with `inspect_workspace_recovery` and use integration/conflict/cleanup primitives only as explicit recovery paths. Never force-clean ambiguous WIP.
11. Refresh the same pinned project and repeat from step 1 without changing `projectId`. After any agent cutoff or reconnect, pull `get_next_action` and follow the DevFlow-owned loop state before attempting another claim. If it returns `confirm-loop-stop`, call `claim_next_task` once to persist terminal state. If `claim_next_task` reports `NO_ELIGIBLE_TASK` with an active loop because `requestedTaskId` is not terminal, resolve that requested scope instead of stopping. Same-project fallback reads exhausting bounded `status=todo` remain candidate stop evidence under the default `todo-only` policy when no durable loop state is available. Under explicit `include-backlog`, exhaust both `status=todo` and `status=backlog`. Never scan or claim from another project merely to keep the loop busy.


## Completed-task evidence reads
The actionable-only collection rule applies to ordinary next-work selection, not to later evidence reads. Completed tasks may still be read when needed for parent/child completion checks, integrated-state verification, review or audit, retrospective/history work, or an explicit user history request. When a completed task is already known by id, prefer `get_task` instead of loading a completed collection.

## Ownership and release
- A successful claim is the source of truth for work ownership; the legacy agent selector is not a claim.
- Idempotent retries by the same session should reuse the same task/workspace rather than create a replacement.
- If abandoning an owned task before completion, use `release_task_claim` when safe so the board does not retain a knowingly stale claim.
- Never release or override another session's claim except explicit emergency recovery requested by the user.

## Parallel scheduling
- Prefer independent child or leaf work with clear target scope.
- Treat overlapping active `targetFiles` as a collision by default.
- When target scope is broad or uncertain, inspect task context before claiming rather than assuming non-overlap.
- Final integration, cleanup, migration, or restart gates wait for their real prerequisites and related active work to settle.

## Runtime and Git safety
- Do not push unless the user explicitly asks.
- Do not restart DevFlow merely to advance a normal board loop while related workers are active.
- Restart only when the claimed scope owns a required runtime/restart gate and its prerequisites are complete.
- Never reset, delete, or overwrite another chat's worktree, branch, or WIP to make the loop progress.

## Stop condition
Stop successfully only when fresh state for the pinned project shows no eligible unclaimed task under the active selection policy **and any requested parent/program completion is terminal**. Under default `todo-only`, remaining backlog does not block exhaustion. Under explicit `include-backlog`, both todo and backlog must be exhausted. `NO_ELIGIBLE_TASK` is sufficient only after those requested completion checks; then stop this worker without scanning another project as fallback.

A blocked stop is valid only when there is a genuine hard blocker or the tool/runtime surface is genuinely unavailable **and no safe alternate eligible work exists**. Foreign ownership or a scope conflict alone is not terminal while independent safe work exists. Preserve blocked WIP and report the bounded blocker identity and the continuation that would resume it.
