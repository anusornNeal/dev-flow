# Worktree Folder Task-Number Naming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make task-owned managed worktrees use only the trailing numeric card number as the visible physical folder while preserving opaque workspace/branch identity and fail-closed collision recovery.

**Architecture:** Extend `createOrReuseSessionWorkspace` with optional task display identity and resolve the visible root leaf independently from `workspaceId`. `taskClaimService` reuses one recoverable task workspace from claim/execution-session evidence before creating a new one, and supplies the task display id only when creation is required. A different unassociated workspace targeting an already-populated card-number root is rejected by the existing occupied-root guard, so no numeric suffix fallback is introduced.

**Tech Stack:** TypeScript, Node.js Git worktrees, node:test, DevFlow managed workspace services.

## Global Constraints

- Valid task ids such as `DVF-0469` and `BSA-0057` must map to folder basenames `0469` and `0057`.
- Never create `0469-2`, `0469-3`, or any suffix fallback.
- Keep `workspaceId` and managed branch naming opaque/hash based.
- Direct non-task session workspace creation remains backward compatible with opaque `ws_*` folder naming.
- Existing containment, Git validation, cleanup, and recovery safety checks remain authoritative.
- Do not push.

---

### Task 1: Add RED coverage for task-number roots and collisions

**Files:**
- Modify: `tests/server/taskClaimService.test.ts`
- Modify: `tests/server/workspaceRootIsolation.test.ts`

**Interfaces:**
- Consumes: `claimTaskForSession(taskId, input)`, `resolveSessionWorkspace(workspaceId)`, `createOrReuseSessionWorkspace(project, sessionId)`.
- Produces: regression expectations that define visible-root behavior without prescribing internal workspace ids or branch hashes.

- [ ] **Step 1: Add task-claim naming tests**

Add fixtures whose display ids are exactly `DVF-0469` and `BSA-0057`. Claim them and resolve their workspace metadata. Assert `path.basename(workspace.root)` is `0469` and `0057`, while `workspaceId` still matches `^ws_[a-f0-9]{16}$` and branch remains under `devflow/ws/`.

- [ ] **Step 2: Add collision test**

Create an unassociated workspace occupying task root `0500`, then claim a task whose display id is `DVF-0500`. The claim must throw `WORKSPACE_ROOT_OCCUPIED`, and the project task-root parent must contain no `0500-2` sibling. Also cover release/reclaim of `DVF-0501`: the new claimant must resume the original workspace id/root instead of creating another workspace.

- [ ] **Step 3: Add direct-session compatibility assertion**

In `workspaceRootIsolation.test.ts`, after direct `createOrReuseSessionWorkspace(project, 'workspace-isolation-session')`, assert the basename still matches `^ws_[a-f0-9]{16}$`.

- [ ] **Step 4: Run focused tests and verify RED**

Run the repository command that executes `tests/server/taskClaimService.test.ts` and `tests/server/workspaceRootIsolation.test.ts`. Expected: new task-number assertions fail because current roots use `ws_*`; existing tests remain otherwise healthy.

---

### Task 2: Pass task identity into workspace root resolution

**Files:**
- Modify: `src/server/services/sessionWorkspaceService.ts`
- Modify: `src/server/services/taskClaimService.ts`

**Interfaces:**
- Produces: `createOrReuseSessionWorkspace(project, sessionId, options?)` where `options.taskDisplayId?: string` controls only the visible root leaf.
- Preserves: workspace id generation, session hash, branch generation, metadata lookup, cleanup, and recovery semantics.

- [ ] **Step 1: Add minimal task-number resolver**

Add a private helper equivalent to:

```ts
function taskNumberFolder(taskDisplayId: unknown) {
  const match = String(taskDisplayId || '').trim().match(/(\d+)$/);
  return match?.[1] || null;
}
```

Keep leading zeroes because the captured value is never converted to a number.

- [ ] **Step 2: Extend managed-root selection**

Change workspace creation to choose:

```ts
const taskFolder = taskNumberFolder(options.taskDisplayId);
const rootLeaf = taskFolder || workspaceId;
const root = canonicalContainment(managedRootFor(project.id, rootLeaf));
```

Do not add any suffix retry. Existing non-empty root handling must continue to throw before Git worktree creation.

- [ ] **Step 3: Wire task claims**

Resolve a single recoverable task workspace first from `task.claim.workspaceId` or active execution sessions. If one exists, reuse it. If multiple recoverable workspaces exist, fail closed as ambiguous. Only when none exists call:

```ts
createOrReuseSessionWorkspace(project, cleanSessionId, { taskDisplayId: task.displayId })
```

Do not derive the task id from `sessionId`.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same two focused test files. Expected: all pass.

---

### Task 3: Verify, document evidence, and integrate

**Files:**
- Modify only if needed: task checklist/evidence metadata through DevFlow tools.

**Interfaces:**
- Consumes: focused GREEN evidence plus TypeScript typecheck.
- Produces: a clean committed DVF-0490 workspace integrated locally into `develop`.

- [ ] **Step 1: Run TypeScript typecheck**

Run project `typecheck`. Expected exit code 0.

- [ ] **Step 2: Review diff and Git status**

Confirm only DVF-0490 target files changed, no conflict markers, no generated artifacts, and no accidental branch/workspace naming changes beyond visible root selection.

- [ ] **Step 3: Complete checklist and commit**

Commit implementation with `[DVF-0490] fix: name worktrees by card number` using task-owned or explicit-file commit safety.

- [ ] **Step 4: Finalize workspace**

Call task workspace finalization with focused-test and typecheck evidence. Integration must be local-only and leave `develop` clean. Do not push.
