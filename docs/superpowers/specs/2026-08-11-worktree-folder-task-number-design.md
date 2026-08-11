# Worktree Folder Task-Number Naming Design

## Goal

Make the human-visible physical folder of a task-owned managed worktree use only the numeric portion of the task display id. Examples: `DVF-0469` -> `0469`, `BSA-0057` -> `0057`.

## Scope

Only task-claim workspace creation changes. Internal `workspaceId` values and managed branch names remain opaque/hash based. Direct non-task calls to `createOrReuseSessionWorkspace(project, sessionId)` remain backward compatible and continue using the opaque workspace id as the physical folder.

## Design

`createOrReuseSessionWorkspace` accepts an optional task display id. When supplied, a helper extracts the trailing numeric card number and uses it as the managed root leaf. The task claim service passes `task.displayId` on both fresh-claim and same-session reuse paths.

The physical task folder is unique by card number. If the expected folder already exists and is not the exact reusable workspace represented by the current workspace metadata, creation fails closed with a recovery/cleanup error. DevFlow never creates `0469-2`, `0469-3`, or another suffix fallback.

Existing containment, Git worktree validation, branch ownership, dirty-worktree recovery, and cleanup checks stay authoritative. Workspace metadata continues to store the absolute managed root so resolution and recovery do not derive paths from task ids later.

## Error handling

A malformed/missing task display id falls back only when the caller omitted task identity entirely. A supplied task display id that has no trailing numeric card number is rejected rather than silently creating an opaque folder, because task claims must have deterministic human-visible roots.

When a task-number root is already occupied, the error explains that the existing folder must be recovered or cleaned before a new workspace for that card can be created.

## Testing

Regression tests must prove:

- `DVF-0469` yields root basename `0469`.
- `BSA-0057` yields root basename `0057`.
- same task/session reuses the same workspace/root.
- an occupied task-number root fails closed and no suffixed sibling is created.
- direct non-task workspace creation still uses opaque `ws_*` folder naming.
- workspace id and branch naming remain opaque and existing isolation behavior remains intact.
