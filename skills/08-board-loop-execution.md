# DevFlow Board Loop Execution

Use this skill when the user asks DevFlow to keep taking work from the board until no eligible work remains, including phrases such as `loop board`, `loop tasks`, `ทำงานบนบอร์ดต่อ`, `หยิบงานบนบอร์ดไปเรื่อยๆ`, or equivalent multi-chat worker instructions.

## Goal

Act as one cooperative board worker. Repeatedly take one eligible scope, complete the full local loop, then refresh the board and take the next eligible scope. Multiple chats may work in parallel, but duplicate claims and overlapping active scope must be avoided.

## Required loop

1. Refresh board/task state before every selection. Prefer concise `search_tasks` pages and inspect parent/children only as needed.
2. Skip work that is already claimed, blocked by dependencies, explicitly reserved for a final gate, or likely to collide with another active scope.
3. Prefer implementation-ready leaf cards. A claimed parent does not lock all children: independent sibling children may run in parallel when their target scope is disjoint and dependencies allow it.
4. Atomically call `claim_task` before implementation. Supply this chat's stable opaque `sessionId` plus a short `ownerLabel` when available. The successful claim moves the card to `in-progress` and returns the managed workspace to use.
5. If `claim_task` returns `TASK_ALREADY_CLAIMED`, refresh and immediately try another eligible card. Do not fight or override the other claimant.
6. If `claim_task` returns `TASK_SCOPE_CONFLICT`, skip that card and try another independent card. Use `allowScopeConflict` only when the user explicitly requests coordinated overlapping work and the collision is understood.
7. Use the returned managed workspace only. Call `get_repo_context_bundle` before implementation, reuse relevant WIP/commits when present, and do not derive or hardcode workspace filesystem paths.
8. Implement only the claimed scope. Use focused tests first, then the verification required by the card. Poll async verification jobs to terminal in the same turn when possible.
9. Commit the claimed scope separately. Recheck latest local `develop` and active sibling work before integration. Resolve from latest `develop` without overwriting another chat's work.
10. Integrate locally with `integrate_workspace`, verify the integrated result when required, and close the card only after evidence passes.
11. Refresh the board and repeat from step 1 until there is no eligible unclaimed work for this worker.

## Ownership and release

- A claim is the source of truth for chat ownership; do not use the legacy card agent selector as a work claim.
- The same session may retry `claim_task` idempotently and reuse its managed workspace.
- If abandoning work before completion, use `release_task_claim` to return the card to `backlog` or `todo`; never leave a knowingly stale claim when a safe release is possible.
- Do not release or override another session's claim except explicit emergency recovery requested by the user.

## Parallelism rules

- Parallelize independent child cards even when they share the same parent.
- Treat overlapping exact `targetFiles` on active claims as a collision by default.
- When target files are incomplete or broad, inspect task context before claiming; do not assume non-overlap merely because file lists are empty.
- Final integration/restart/cleanup gate cards wait for all required children and active related work to settle.

## Git and runtime safety

- Do not push unless the user explicitly asks.
- Do not restart DevFlow while ordinary board-loop workers or related active claims are still running.
- Restart only when the currently claimed card explicitly owns a final restart/runtime gate and its dependencies are complete; perform the minimum required restart and verify after reconnect.
- Never reset, delete, or overwrite another chat's worktree/WIP to make your own task easier.

## Stop condition

Stop successfully when a fresh board read shows no eligible unclaimed work for this worker. Report blockers separately from completed work; do not claim blocked cards merely to keep the loop busy.
