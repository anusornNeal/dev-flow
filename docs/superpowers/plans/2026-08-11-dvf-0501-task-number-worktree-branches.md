# Task-Number Worktree Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task-owned DevFlow worktrees use the exact trailing card number as their local Git branch name while preserving opaque workspace ids and existing safety/recovery behavior.

**Architecture:** Keep task identity derivation in `sessionWorkspaceService.ts`, where task-owned root selection already happens. Introduce a single task-branch resolver that returns the existing opaque managed branch for standalone sessions and the exact trailing task number for task-owned workspaces. Treat numeric task branches as managed only when the workspace metadata proves the branch belongs to that task, so cleanup can safely remove them while project-wide legacy branch cleanup remains restricted to the `devflow/ws/...` namespace. Branch collisions fail closed unless the already-recorded workspace is a validated same-task reuse.

**Tech Stack:** TypeScript, Node.js `spawnSync`, Git worktrees, `node:test`, DevFlow managed workspace services.

## Global Constraints

- `DVF-0499` must use branch `0499`; `BSA-0057` must use branch `0057` and preserve leading zeroes.
- Task-owned physical worktree roots remain task-numbered.
- `workspaceId` remains opaque/internal.
- Standalone non-task session workspaces retain the existing `devflow/ws/<project>/<hash>` branch naming.
- No `-2`, `-copy`, or random fallback branch is permitted for task-owned workspaces.
- Existing dirty, active, integration-required, conflicted, unique-commit, or otherwise ambiguous legacy workspaces are preserved for recovery.
- No automatic push or DevFlow restart.

---

### Task 1: Lock numeric task-branch behavior with RED tests

**Files:**
- Modify: `tests/server/sessionWorkspaceService.test.ts`
- Modify: `tests/server/taskClaimService.test.ts`

**Interfaces:**
- Consumes: `createOrReuseSessionWorkspace(project, sessionId, { taskDisplayId })`, `claimTaskForSession(taskId, input)`.
- Produces: regression expectations that task-owned branches equal the trailing card number and standalone branches remain opaque.

- [ ] **Step 1: Extend task-owned workspace tests**

Add assertions equivalent to:

```ts
assert.equal(taskA.branch, '0489');
assert.equal(taskB.branch, '0490');
assert.match(standalone.branch, /^devflow\/ws\//);
```

Add a BSA fixture and assert `BSA-0057` produces branch `0057`.

- [ ] **Step 2: Extend task-claim visible branch tests**

Change the existing DVF/BSA task-folder test so claimed workspace branches must equal `0469` and `0057` rather than merely matching `^devflow/ws/`.

- [ ] **Step 3: Run focused tests and verify RED**

Run the repository's focused command for `tests/server/sessionWorkspaceService.test.ts` and `tests/server/taskClaimService.test.ts`.

Expected: assertions fail because current task-owned branches are still `devflow/ws/<project>/<hash>`.

---

### Task 2: Derive task-owned branches from card numbers and fail closed on collisions

**Files:**
- Modify: `src/server/services/sessionWorkspaceService.ts`

**Interfaces:**
- Consumes: `taskNumberFolder(taskDisplayId)`, existing workspace metadata, existing branch/worktree inspection helpers.
- Produces: task-owned `SessionWorkspace.branch` equal to `taskRootLeaf`; standalone `SessionWorkspace.branch` stays under `devflow/ws/...`.

- [ ] **Step 1: Add one branch-name resolver**

Add a helper with behavior equivalent to:

```ts
function workspaceBranchFor(projectId: string, workspaceIdentity: string, taskRootLeaf: string | null) {
  return taskRootLeaf || `${managedBranchPrefix(projectId)}${sessionHash(workspaceIdentity)}`;
}
```

Do not parse the task number as an integer.

- [ ] **Step 2: Use the resolver before worktree creation**

Compute `taskRootLeaf` once, use it for both the physical root leaf and task-owned branch name, and keep the existing opaque branch for non-task sessions.

- [ ] **Step 3: Fail closed when a task branch already exists without reusable metadata**

Before attaching an existing branch, if the workspace is task-owned and `branchExists(projectRoot, branch)` is true after reusable metadata resolution has already failed, throw a structured `WORKSPACE_BRANCH_COLLISION` error. Do not attach, reset, rename, suffix, or delete that branch.

- [ ] **Step 4: Keep standalone legacy attach behavior unchanged**

For non-task session branches under `devflow/ws/...`, preserve the existing behavior that can reattach an existing unoccupied managed branch.

- [ ] **Step 5: Run focused workspace tests**

Expected: numeric branch tests pass and existing standalone/restart/dirty/unique-commit tests remain green.

---

### Task 3: Make cleanup recognize metadata-proven numeric task branches

**Files:**
- Modify: `src/server/services/sessionWorkspaceService.ts`
- Test: `tests/server/sessionWorkspaceService.test.ts`

**Interfaces:**
- Consumes: `SessionWorkspace.taskRootLeaf`, `SessionWorkspace.branch`, existing `getManagedBranchDisposition` and `removeManagedBranchIfSafe` safety checks.
- Produces: safe cleanup of task-number branches without broadening project-wide deletion to arbitrary numeric branches.

- [ ] **Step 1: Add a metadata-bound managed-branch predicate**

A branch is managed when either:

```ts
branch.startsWith(managedBranchPrefix(projectId))
```

or the caller supplies a task root leaf and:

```ts
branch === taskRootLeaf
```

Only workspace-specific cleanup may supply the task root leaf. `cleanupManagedWorkspaceBranches()` must continue enumerating only `devflow/ws/...` refs.

- [ ] **Step 2: Pass task metadata through workspace-specific disposition checks**

Update `removeManagedBranchIfSafe()` and `cleanupSessionWorkspace()` to validate `workspace.branch` with `workspace.taskRootLeaf` before deleting a numeric task branch.

- [ ] **Step 3: Add cleanup regression**

Create a task-owned workspace, keep it clean and integrated with its base, call `cleanupSessionWorkspace`, and assert both the numbered worktree and numeric local branch are removed.

- [ ] **Step 4: Run workspace cleanup tests**

Expected: numeric task branch cleanup succeeds; unique-commit and dirty workspaces still block.

---

### Task 4: Verify claim/reclaim, collision, and integration compatibility

**Files:**
- Modify: `tests/server/taskClaimService.test.ts`
- Modify: `tests/server/workspaceIntegrationService.test.ts`
- Production changes only if a failing regression proves an assumption in `taskClaimService.ts` or `workspaceIntegrationService.ts` depends on the old branch prefix.

**Interfaces:**
- Consumes: task workspace metadata branch identity.
- Produces: proof that higher-level lifecycle services treat numeric branches as ordinary authoritative workspace branches.

- [ ] **Step 1: Add same-task reclaim assertion**

The existing release/reclaim test must assert both claimers resolve the same numeric branch, e.g. `0501`.

- [ ] **Step 2: Add incompatible numeric branch collision fixture**

Create an unrelated local branch named `0500` without compatible DevFlow workspace metadata, then claim `DVF-0500` and assert `WORKSPACE_BRANCH_COLLISION`. Assert no `0500-2` or opaque task fallback branch is created.

- [ ] **Step 3: Add integration fixture using a task-owned numeric branch**

Create a workspace with `{ taskDisplayId: 'DVF-0801' }`, commit a file, integrate it, and assert `result.sourceBranch === '0801'` and integration succeeds.

- [ ] **Step 4: Run focused claim/integration tests**

Expected: claim/reclaim/collision/integration behavior is green without changes outside the workspace lifecycle unless tests prove otherwise.

---

### Task 5: Final verification and commit

**Files:**
- Verify changed source/tests/docs only.

**Interfaces:**
- Produces: one DVF-0501-owned local commit ready for DevFlow finalization.

- [ ] **Step 1: Run the focused workspace/claim/integration test set**

Run the exact project test command covering:
- `tests/server/sessionWorkspaceService.test.ts`
- `tests/server/taskClaimService.test.ts`
- `tests/server/workspaceIntegrationService.test.ts`

Expected: all pass.

- [ ] **Step 2: Run TypeScript typecheck**

Expected: exit code 0.

- [ ] **Step 3: Inspect task-owned commit scope**

Use DevFlow task commit planning and confirm no unrelated dirty files are included.

- [ ] **Step 4: Commit task-owned changes**

Commit with DevFlow policy using a message equivalent to `fix(workspace): use task numbers for managed worktree branches`.

- [ ] **Step 5: Finalize locally**

Integrate the clean committed workspace into local `develop`, attach exact verification evidence, close DVF-0501, and safely remove the completed worktree/branch. Do not push.
