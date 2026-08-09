# DVF-0356 Regression — Workspace-bound Git evidence

**Goal:** Prevent task Git/review evidence from silently binding to unrelated `develop` revisions when implementation happened in a managed worktree.

**Architecture:** Reuse the existing project root resolver, which already validates opaque `workspaceId` against the project and resolves the managed worktree internally. Task Git workflow forwards `workspaceId`, records the opaque evidence source, and rejects branch-mismatched sync evidence before it can overwrite a task record. Project-root behavior remains unchanged when `workspaceId` is omitted. Review diagnostics may inspect a mismatched branch, but must not persist that diagnostic Git evidence over prior trusted evidence.

## Completed TDD steps
- [x] Added a managed-workspace regression where the task source commit differs from a concurrently advanced `develop`; `syncTaskWithGit(..., workspaceId)` records the workspace branch/source HEAD.
- [x] Added a regression proving omitted `workspaceId` for a task expecting the isolated branch throws `TASK_GIT_EVIDENCE_BRANCH_MISMATCH` instead of returning misleading `develop` evidence.
- [x] Added a wrong-project workspace regression proving the existing workspace resolver rejects the opaque id with `WORKSPACE_NOT_FOUND`.
- [x] Exposed optional `workspaceId` on `sync_task_with_git` and `submit_task_for_review` task-tool schemas without modifying the aggregate `devflowContract.ts` surface owned by concurrent work.
- [x] Forwarded `workspaceId` into `getGitSyncStatus`, recorded `evidenceSource` plus opaque `workspaceId`, and added strict branch provenance validation for explicit sync.
- [x] Prevented blocked review routes from persisting branch-mismatched diagnostic Git evidence over the task's prior evidence.
- [x] Added contract/route regression guards for the new schema and persistence behavior.

## Verification
- [x] `test-dvf0356-git-evidence`: 10/10 pass, including concurrent-develop provenance, wrong-project workspace validation, existing push/sync/review cache reuse, persistence, and warning behavior.
- [x] `test-dvf0356-contract-route`: 7/7 pass.
- [x] Workspace/isolation/integration regressions: 9/9 pass.
- [x] MCP tool-profile regressions: 7/7 pass.
- [x] Built-in global TypeScript `typecheck`: exit 0.
- [x] Final focused rerun remains green after all edits.

**Post-plan workflow:** commit this isolated-workspace regression scope, integrate locally into `develop`, document the implementation/review provenance on DVF-0356, and do not push unless the user explicitly asks.
