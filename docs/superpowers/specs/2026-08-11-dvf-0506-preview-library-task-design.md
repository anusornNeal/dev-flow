# DVF-0506 — Preview Library and Task Design Affordances

## Goal

Polish DevFlow's UI Preview workflow without weakening frozen task-design evidence. The Preview Library remains the live/latest workspace, while Task UI Design remains immutable evidence attached to a task.

This design covers only the task/UI surface. Worker/agent prompt delivery of design context is explicitly out of scope and is owned by separate work.

## Selected UX Model

Use a three-level hierarchy with no duplicate frozen-design actions:

1. **Board card — presence only.** A compact icon+label `Design` badge appears only when the task has frozen UI Design evidence. It is informational and does not add a nested navigation target.
2. **Task Overview — frozen design.** The current frozen screenshot is the primary visual and the single `Open Design` click target. Clicking it opens the frozen preview revision.
3. **Open Latest — newer mutable work only.** Show `Open Latest` only when `latestRevision > frozenRevision`. It opens the current mutable preview and is visually secondary to the frozen screenshot.

Do not add a second `Open Design` action in the Task Detail header, and do not keep a duplicate `Open Preview` control beneath the screenshot for the same frozen revision.

Design reference: DevFlow UI preview `uip_ba894ee4d78f4a3e9996dbe7284c0cc7`, revision 3.

## Preview Library

### Hidden internal IDs

`previewId` remains the canonical internal identifier for keys, routes, attach, delete, evidence identity, and storage. The Library must not render the identifier as user-facing copy. Untitled previews must use a neutral fallback label such as `Untitled preview`, never `previewId`.

### Safe deletion

Only standalone previews are deletable from the Library.

The database currently has cascading relationships from `ui_previews` to `ui_preview_revisions`, and from preview revisions to `task_ui_evidence`. Therefore deleting a linked preview could remove frozen task evidence. The backend must reject linked deletion even if a caller bypasses the UI.

Standalone deletion flow:

- Render a destructive `Delete` action only for standalone previews.
- Require explicit confirmation.
- On success, remove the card from current Library state immediately.
- On failure, keep the card visible and show an actionable error.
- Missing preview returns not-found without affecting other records.
- Linked preview deletion returns a conflict-style error and leaves preview revisions and task evidence unchanged.

### Live background updates

Preview create, update, bind, and delete mutations must publish a canonical `ui-preview.changed` domain event after the mutation commits successfully.

The open Preview Library subscribes through the existing server-event infrastructure and refreshes in the background. It must not:

- reload the browser,
- reset the route/hash,
- clear currently visible cards while the request is pending,
- flash an empty list,
- return to the initial full-page loading spinner.

Existing request-generation/stale-response guards remain authoritative so older event-triggered responses cannot overwrite newer filter or refresh state. Manual `Refresh` remains available as an explicit fallback.

## Board Design Signal

The Board needs one lightweight task-level signal such as `hasUiDesign` in the board response.

Requirements:

- Compute the signal in a bounded/batched server read path.
- Do not issue one UI-evidence request per task/card.
- `TaskCard` renders a compact icon+label `Design` badge only when the signal is true.
- The badge is non-clickable and does not interfere with the task card's existing click, drag, delete, or claim behavior.
- No design evidence means no placeholder badge.
- When a task gains its first frozen UI evidence, the existing reactive task/event flow must refresh the Board so the badge appears without F5/manual reload.

## Task Overview Design Surface

The existing UI Design evidence section remains the canonical detailed surface for screenshot, revision metadata/history, and latest comparison.

For the current evidence item:

- If a screenshot and `frozenPreviewUrl` exist, render the screenshot as a clear click target.
- Clicking the screenshot opens `frozenPreviewUrl` safely in a new tab/window.
- Add visual affordance on the image/card so it is obvious that the screenshot is interactive, for example an `Open Design` overlay/label.
- Do not render a second frozen `Open Preview` action beneath the screenshot.
- Do not add a duplicate Task Detail header `Open Design` action.
- Show `Open Latest` only when `latestRevision > frozenRevision` and `latestPreviewUrl` is present.
- Loading/error/no-evidence states must not render a misleading active frozen-design action.
- Previous revision history remains available as metadata/history; do not expand scope into new history browsing UX.

## Data and Event Flow

### Preview mutation

`create/update/bind/delete` -> repository/service mutation -> committed database state -> publish `ui-preview.changed` -> open Preview Library background refresh.

Failed/conflicting mutations must not publish a success change event.

### First task design evidence

Successful evidence attach -> current frozen evidence exists -> publish/trigger the existing task-domain invalidation used by the Board -> Board task summary refresh -> `hasUiDesign=true` -> `Design` badge appears.

### Board reads

Board collection query -> one bounded task summary result including `hasUiDesign` -> `TaskCard` renders directly. No per-card follow-up evidence HTTP calls.

## Error Handling

- Linked preview delete: conflict; no data mutation and no success event.
- Missing preview delete: not-found; no unrelated data mutation.
- Background Library refresh failure: keep current cards visible and surface refresh error without resetting initial-loading state.
- Evidence loading failure in Task Overview: keep the design action absent until valid evidence is available.
- Stale responses: ignore via existing generation/request gate.

## Testing

Add or extend focused coverage for:

- standalone preview deletion removes preview and revisions,
- linked deletion is rejected and frozen evidence remains intact,
- missing preview delete behavior,
- preview events on successful create/update/bind/delete only,
- Preview Library hidden UUID, standalone Delete vs linked no-Delete, confirmation paths, non-destructive live refresh, stale-response suppression, and StrictMode regression,
- board task summary false/true `hasUiDesign` behavior without N+1 reads,
- `TaskCard` Design badge present only when true and non-clickable,
- successful first evidence attach causes the Board's reactive state to acquire the badge,
- Task Overview frozen screenshot targets `frozenPreviewUrl`,
- no duplicate Task Detail header `Open Design` and no duplicate frozen `Open Preview`,
- `Open Latest` appears only when latest revision is newer and targets `latestPreviewUrl`,
- no misleading design action during loading/error/no-evidence states.

Run focused Preview Library, server-event, task-card/task-design tests, then typecheck and production build.

## Scope Boundaries

Do not implement any of the following in DVF-0506:

- worker/agent prompt or agent-context design delivery,
- a permanent Design tab,
- clickable Board Design badge/navigation,
- per-card evidence HTTP requests,
- duplicate frozen-design actions,
- bulk delete, trash/restore, artifact GC,
- project-scoping migration,
- high-frequency polling or F5-style refresh,
- changes to the already-applied UI preview database migration.
