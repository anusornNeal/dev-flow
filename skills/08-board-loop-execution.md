# DevFlow Board Loop Execution

## Purpose
Use this skill when the user asks DevFlow to keep taking eligible work from the board, such as `loop board`, `loop tasks`, or equivalent multi-chat worker instructions.

This skill owns board orchestration only. Load `07-authoring-execution` for implementation, edit, test, verification, commit, workspace-terminal, and recovery details.

## Goal
Act as one cooperative board worker. Repeatedly claim one eligible scope, complete its local task loop, refresh the board, and take another eligible scope until no safe work remains for this worker.

## Required loop
1. For ordinary next-card selection, prefer `claim_next_task` with the project id and this chat's stable session identity. It performs bounded selection and the authoritative claim under the project lock.
2. If the user names a specific card, selection is ambiguous, the fast path is unavailable, or it reports no eligible task, fall back only to actionable task collections: use bounded `search_tasks` with `mode=minimal` or `mode=summary`, inspect `status=backlog` and `status=todo` as separate claimable lanes, then use explicit `claim_task`. Do not use an unfiltered collection, `all=true`, full/debug density, or a `done` collection for ordinary next-work selection. A backlog-only read is never proof that no eligible work remains.
3. If `claim_task` returns `TASK_ALREADY_CLAIMED`, do not override the owner. Refresh and choose another eligible task.
4. If `claim_task` returns `TASK_SCOPE_CONFLICT`, skip the conflicting card and choose independent work. Allow overlapping scope only when the user explicitly requests coordinated overlap and the collision is understood.
5. Use only the managed workspace returned by the successful claim. Load `07-authoring-execution` and implement exactly the claimed scope under its ownership and verification policy.
6. Independent sibling children may run in parallel when target scope is disjoint and no real prerequisite blocks them. A shared parent does not serialize siblings by itself.
7. Before terminal completion, refresh relevant local base/sibling state so integration does not overwrite newer independent work.
8. After the execution specialist has produced a clean committed workspace and required checks, prefer `finalize_task_workspace` for the terminal task flow.
9. If finalization reports `needs-recovery`, preserve the workspace. Inspect with `inspect_workspace_recovery` and use integration/conflict/cleanup primitives only as explicit recovery paths. Never force-clean ambiguous WIP.
10. Refresh the board and repeat from step 1. When fallback selection is needed to prove a stop condition, exhaust both bounded claimable lanes (`status=backlog` and `status=todo`) before concluding no eligible unclaimed work remains.


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
Stop successfully when fresh board state shows no eligible unclaimed task for this worker. Report blocked/conflicting work separately instead of claiming it only to keep the loop busy.
