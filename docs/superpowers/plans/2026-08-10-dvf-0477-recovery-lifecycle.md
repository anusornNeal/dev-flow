# DVF-0477 Recovery Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover false-DONE/lost task scope and make managed workspace completion/recovery deterministic without losing unique commits, dirty owned work, or semantic conflicts.

**Architecture:** Extend existing DVF-0401 execution ownership rather than inventing a second provenance model. Add a small task commit-planning service, a state-aware workspace recovery service, patch-equivalent integration recognition, and an explicit finalization path that composes existing integration/evidence/status/cleanup primitives. Manual DONE overrides remain possible, but unfinished scope requires a persisted recovery disposition.

**Tech Stack:** TypeScript, Node.js child_process Git plumbing, Express routes, existing SQLite task/execution repositories, DevFlow MCP contracts, node:test.

## Global Constraints

- Target local `develop`; never push automatically.
- Managed workspaces remain opaque; callers persist only `workspaceId`.
- Semantic Git conflicts are never auto-resolved.
- Unique committed work is never discarded.
- Ambiguous/unrelated dirty work is preserved as `needs-recovery`.
- Reuse DVF-0401 execution ownership/provenance as authoritative scope truth.
- Default repository integration policy remains rebase + fast-forward unless project policy says merge.

---

### Task 1: Evidence-based workspace inspection and patch-equivalent supersession

**Files:**
- Modify: `src/server/services/workspaceIntegrationService.ts`
- Create: `src/server/services/workspaceRecoveryService.ts`
- Modify: `src/server/contracts/devflowWorkspaceTools.ts`
- Modify: `src/server/routes/devflow.ts`
- Test: `tests/server/workspaceIntegrationService.test.ts`
- Create: `tests/server/workspaceRecoveryService.test.ts`

**Interfaces:**
- Produces `inspectWorkspaceRecovery(workspaceId): WorkspaceRecoveryInspection` with disposition `already-integrated | patch-equivalent | committed-not-integrated | dirty-owned | needs-recovery | stale-registry`.
- Produces `finalizeSupersededWorkspace(workspaceId, { supersededByCommit, temporaryPaths }): { removed, disposition }` and refuses any path not proved equivalent/temporary.
- `integrateWorkspaceCommits()` recognizes `git cherry <baseHead> <sourceHead>` results containing only `-` entries as patch-equivalent and marks the workspace integrated without replaying the source commit.

- [ ] **Step 1: Write failing integration tests for recreated-equivalent commits**

Create a temporary repo where an old workspace commit and a later develop commit have the same patch but different hashes. Assert `integrateWorkspaceCommits()` returns `alreadyIntegrated: true`, `patchEquivalent: true`, leaves base HEAD unchanged, and clears `integration-required` state.

- [ ] **Step 2: Run the focused integration test and verify RED**

Run `npx tsx --test tests/server/workspaceIntegrationService.test.ts` and confirm the recreated-equivalent case currently conflicts/rebases instead of being recognized.

- [ ] **Step 3: Implement patch-equivalence detection**

Add a helper equivalent to:

```ts
function patchEquivalentToBase(root: string, baseHead: string, sourceHead: string) {
  const result = runGit(root, ['cherry', baseHead, sourceHead], { allowFailure: true });
  if (result.status !== 0) return false;
  const rows = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return rows.length > 0 && rows.every((line) => line.startsWith('- '));
}
```

Call it after the direct-ancestor fast path and before starting merge/rebase conflict state. Preserve source commit/history and only advance workspace metadata to the current base revision.

- [ ] **Step 4: Write recovery inspection RED fixtures**

Cover a clean integrated workspace, unique committed workspace, owned dirty workspace, unrelated dirty workspace, stale registry/root mismatch, and a patch-equivalent superseded workspace.

- [ ] **Step 5: Implement bounded recovery inspection and explicit superseded cleanup**

Read registry metadata through existing session workspace primitives, inspect Git status/heads/cherry, and use execution ownership when a task/session is supplied. `finalizeSupersededWorkspace` must require a develop-contained `supersededByCommit`; dirty paths not matched by authoritative owned/superseded evidence or explicitly listed as temporary must return `needs-recovery` without deletion.

- [ ] **Step 6: Run focused workspace tests GREEN**

Run `npx tsx --test tests/server/workspaceIntegrationService.test.ts tests/server/workspaceRecoveryService.test.ts`.

### Task 2: Recover DVF-0402 task-aware commit plan and scoped local commit

**Files:**
- Create: `src/server/services/taskCommitPlanService.ts`
- Modify: `src/server/contracts/devflowGitTools.ts`
- Modify: `src/server/routes/devflow.ts`
- Modify: `src/server/services/mcpToolJobRunnerRegistry.ts`
- Create: `tests/server/taskCommitPlanService.test.ts`
- Modify: `skills/07-authoring-execution.md`

**Interfaces:**
- `buildTaskCommitPlan(state, { taskId, workspaceId? })` returns `ownedChangedFiles`, `unrelatedChangedFiles`, `ownershipDrift`, `verificationFresh`, and `commitAllowed`.
- `commitTaskOwnedChanges(state, { taskId, workspaceId?, message, dryRun? })` delegates to existing `commitGitChanges` with an explicit `files` list only; it never uses `stageAll`.

- [ ] **Step 1: Write RED fixtures around DVF-0401 ownership**

Create an execution session owning `src/a.ts`, dirty both `src/a.ts` and `src/unrelated.ts`, and assert the plan selects only `src/a.ts`; drift/stale verification blocks commit.

- [ ] **Step 2: Run focused test RED**

Run `npx tsx --test tests/server/taskCommitPlanService.test.ts`.

- [ ] **Step 3: Implement minimal planner/committer**

Use `listExecutionSessionsForTask()` + `getExecutionOwnershipState()` and current Git status. Reject no active matching session, ownership drift, or zero owned changes with structured codes. For commit, call `commitGitChanges(state, { ...project/workspace identity, message, files: plan.ownedChangedFiles, dryRun })`.

- [ ] **Step 4: Add MCP contracts/routes and skill guidance**

Expose `plan_task_commit` as lightweight/read-only and `commit_task_owned_changes` as `repo-command`; document that scoped commit is preferred whenever execution ownership exists.

- [ ] **Step 5: Run focused tests GREEN**

Run task-commit-plan test plus existing execution-session and git-service tests.

### Task 3: Persist recovery disposition on manual DONE override

**Files:**
- Modify: `src/server/routes/taskWorkflowRoutes.ts`
- Modify: `src/server/contracts/devflowTaskTools.ts`
- Modify: `src/server/useCases/taskUseCases.ts`
- Test: `tests/server/taskRouteModules.test.ts`

**Interfaces:**
- Manual DONE requests that bypass unfinished-scope blockers accept `recoveryDisposition: { classification, summary, followUpTaskId?, workspaceId? }`.
- If bypassed blockers include incomplete checklist/missing evidence/unfinished children and no disposition is supplied, return `MOVE_RECOVERY_DISPOSITION_REQUIRED` even when `manualOverride=true`.
- Persist the normalized disposition in task logs and `workflowWarnings` so future audit reads can distinguish intentional supersession/follow-up from silent loss.

- [ ] **Step 1: Add RED route tests**

Assert manual override to DONE with incomplete checklist is rejected without disposition and succeeds with a bounded structured disposition visible on the task.

- [ ] **Step 2: Implement normalization and persistence**

Accept classifications `confirmed-missing | recoverable-workspace | implemented-metadata-drift | superseded | follow-up`. Require a non-empty summary and validate optional task/workspace ids as opaque strings.

- [ ] **Step 3: Run route tests GREEN**

Run `npx tsx --test tests/server/taskRouteModules.test.ts`.

### Task 4: Deterministic local finalization and clean workspace removal

**Files:**
- Create: `src/server/services/taskWorkspaceFinalizationService.ts`
- Modify: `src/server/contracts/devflowWorkspaceTools.ts`
- Modify: `src/server/routes/devflow.ts`
- Create: `tests/server/taskWorkspaceFinalizationService.test.ts`
- Modify: `skills/08-board-loop-execution.md`

**Interfaces:**
- `finalizeTaskWorkspace(state, { taskId, workspaceId, checks, requireChecklistComplete=true })` executes only on committed/clean workspace work.
- Sequence: validate task/workspace → integrate (or recognize already/patch-equivalent integrated) → sync Git/verification evidence against local develop → mark execution session completed/release claim as applicable → move task to DONE through normal workflow rules → cleanup clean integrated workspace.
- On any conflict/dirty/ambiguous state, stop before destructive cleanup and return `needs-recovery` with the workspace preserved.

- [ ] **Step 1: Add RED lifecycle fixtures**

Cover committed workspace success (worktree/branch removed), already-integrated workspace success, integration conflict preservation, and dirty workspace preservation.

- [ ] **Step 2: Implement finalizer by composing existing services**

Do not duplicate Git integration. Call `integrateWorkspaceCommits`, `syncTaskWithGit`/task persistence helpers, execution completion, task move validation, then `cleanupSessionWorkspace`. Never fetch or push.

- [ ] **Step 3: Update board-loop guidance**

Make finalization the preferred terminal operation; keep explicit primitives as recovery/debug fallbacks.

- [ ] **Step 4: Run lifecycle tests GREEN**

Run focused finalization, integration, session workspace, task workflow, and execution ownership tests.

### Task 5: Inventory evidence, regression matrix, and final verification

**Files:**
- Create: `docs/workflow-integrity/dvf-0477-audit.md`
- Modify: `tests/server/devflowContractModules.test.ts` or the nearest contract registry regression to include new tools.

**Interfaces:**
- Audit rows contain task id, classification, evidence inspected, missing scope, workspace/commit disposition, and recovery action.

- [ ] **Step 1: Record confirmed historical classifications**

Record DVF-0379=`confirmed-missing parent/follow-up`, DVF-0402=`confirmed-missing then recovered by Task 2`, DVF-0401=`implemented-metadata-drift/preserved`, DVF-0361/0362/0363=`implemented-metadata-drift`, old DVF-0459 workspace=`superseded patch-equivalent`, old DVF-0465 dirty workspace=`superseded + temporary test override`, and stale-registry task-claim workspace according to inspection evidence.

- [ ] **Step 2: Add contract/regression coverage**

Assert new tools remain local-only, workspace ids stay opaque, no push action is introduced, and cleanup/recovery errors are structured.

- [ ] **Step 3: Run focused matrix**

Run `npx tsx --test` for task commit planning, execution ownership, workspace lifecycle/integration/recovery/finalization, task workflow routes, Git contracts, and tool contract registry.

- [ ] **Step 4: Run TypeScript typecheck**

Run `npm run typecheck` and require zero errors.

- [ ] **Step 5: Run repository final verification lane**

Run `npm run verify` fresh. Inspect Git diff/status for scope drift, then create a local commit only for DVF-0477 files, integrate to local `develop`, rerun focused integrated smoke, sync evidence, close DVF-0477, and clean its managed workspace. Never push.
