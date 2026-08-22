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
1. For ordinary next-card selection, prefer `claim_next_task` with the same pinned `projectId` and this chat's stable session identity. It performs bounded selection and the authoritative claim under that project lock.
2. If the user names a specific card, selection is ambiguous, or the fast path is unavailable, fall back only to actionable task collections in the same pinned `projectId`: use bounded `search_tasks` with `mode=minimal` or `mode=summary`, inspect `status=backlog` and `status=todo` as separate claimable lanes, then use explicit `claim_task` only for a task returned from that same project. Do not use an unfiltered collection, `all=true`, full/debug density, or a `done` collection for ordinary next-work selection. A backlog-only read is never proof that no eligible work remains.
3. If `claim_task` returns `TASK_ALREADY_CLAIMED`, do not override the owner. Refresh and choose another eligible task.
4. If `claim_task` returns `TASK_SCOPE_CONFLICT`, skip the conflicting card and choose independent work. Allow overlapping scope only when the user explicitly requests coordinated overlap and the collision is understood.
5. If foreign dirty WIP owns a conflicting card, preserve it and choose safe non-overlapping eligible work. Report blocked only when no safe alternate eligible work exists.

6. Use only the managed workspace returned by the successful claim. Load `07-authoring-execution` and implement exactly the claimed scope under its ownership and verification policy.
7. Independent sibling children may run in parallel when target scope is disjoint and no real prerequisite blocks them. A shared parent does not serialize siblings by itself.
8. Before terminal completion, refresh relevant local base/sibling state so integration does not overwrite newer independent work.
9. After the execution specialist has produced a clean committed workspace and required checks, prefer `finalize_task_workspace` for the terminal task flow. A clean commit or passing verification is not a response boundary; continue through required finalization and cleanup.
10. If finalization reports `needs-recovery`, preserve the workspace. Inspect with `inspect_workspace_recovery` and use integration/conflict/cleanup primitives only as explicit recovery paths. Never force-clean ambiguous WIP.
11. Refresh the same pinned project and repeat from step 1 without changing `projectId`. If `claim_next_task` reports `NO_ELIGIBLE_TASK`, or same-project fallback reads exhaust both bounded claimable lanes (`status=backlog` and `status=todo`), treat that as candidate stop evidence. If the user requested a parent/program, finish its remaining terminal orchestration and completion checks before stopping. When no requested parent/program work remains, stop this worker. Never scan or claim from another project merely to keep the loop busy.


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
Stop successfully only when fresh state for the pinned project shows no eligible unclaimed task for this worker **and any requested parent/program completion is terminal**. `NO_ELIGIBLE_TASK` and empty actionable backlog+todo are sufficient only after those requested completion checks; then stop this worker without scanning another project as fallback.

A blocked stop is valid only when there is a genuine hard blocker or the tool/runtime surface is genuinely unavailable **and no safe alternate eligible work exists**. Foreign ownership or a scope conflict alone is not terminal while independent safe work exists. Preserve blocked WIP and report the bounded blocker identity and the continuation that would resume it.
