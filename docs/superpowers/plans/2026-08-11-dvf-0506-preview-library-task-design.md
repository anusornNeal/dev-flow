# DVF-0506 Preview Library and Task Design Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Preview Library deletion/live-refresh safe and clear, surface a lightweight Board `Design` presence signal, and make the frozen screenshot in Task Overview the single frozen-design open action.

**Architecture:** Keep preview identity and frozen evidence semantics unchanged. Add deletion and `ui-preview.changed` publication at the preview mutation boundary, let the Library consume that event with a silent/background reload, expose only a boolean `hasUiDesign` summary on board task payloads using one bounded SQL read, and reuse existing Task UI evidence data for the Overview screenshot interaction. Evidence attachment publishes task invalidation after committed evidence changes so the existing Board refresh path picks up the badge.

**Tech Stack:** TypeScript 5.8, React 19, Express 4, better-sqlite3, Node test runner via `tsx --test`, existing DevFlow SSE event broker, lucide-react.

## Global Constraints

- Preview Library is live/latest; Task UI Design remains frozen immutable evidence.
- Linked previews cannot be deleted because preview-revision deletion cascades into `task_ui_evidence`.
- `previewId` remains internal but must not be rendered as user-facing Library copy.
- No F5/browser reload, blank-list flash, or initial-spinner reset during reactive Library refresh.
- Board design discovery must not use one evidence request per task/card.
- Board `Design` badge is informational and non-clickable.
- Frozen screenshot in Task Overview is the single primary frozen `Open Design` interaction.
- Do not add a duplicate Task Detail header `Open Design` or duplicate frozen `Open Preview` button.
- `Open Latest` is shown only when `latestRevision > frozenRevision`.
- Worker/agent prompt/context delivery is out of scope.
- No push.

---

### Task 1: Standalone-only Preview Deletion Contract

**Files:**
- Modify: `src/server/domain/uiPreview.ts`
- Modify: `src/server/repositories/uiPreviewRepository.ts`
- Modify: `src/server/services/uiPreviewService.ts`
- Modify: `src/server/routes/uiPreviews.ts`
- Modify: `src/client/uiPreviewClient.ts`
- Test: `tests/server/uiPreviewRepository.test.ts`
- Test: `tests/server/uiPreviewService.test.ts`
- Test: `tests/server/uiPreviewRoutes.test.ts`
- Test: `tests/client/uiPreviewClient.test.ts`

**Interfaces:**
- Produces repository method `deleteStandalonePreview(previewId: string)` returning bounded deletion identity.
- Produces service method `delete(input: { previewId: string })`.
- Produces HTTP `DELETE /api/ui-previews/:previewId`.
- Produces client helper `deleteUiPreview(previewId: string)` using existing `apiDelete`.

- [ ] **Step 1: Write repository RED tests**

Add tests that create a standalone preview with multiple revisions, delete it, and assert `ui_previews` + `ui_preview_revisions` rows are gone. Add a linked preview/evidence fixture and assert deletion throws a conflict error while preview, revisions, and `task_ui_evidence` counts remain unchanged. Add missing-preview coverage.

Expected domain errors:

```ts
new UiPreviewNotFoundError(previewId)
new UiPreviewError(
  'UI_PREVIEW_DELETE_LINKED_CONFLICT',
  `UI preview '${previewId}' is linked to task '${taskId}' and cannot be deleted from the Preview Library.`,
)
```

- [ ] **Step 2: Run repository tests and confirm RED**

Run:

```bash
npx tsx --test tests/server/uiPreviewRepository.test.ts
```

Expected: FAIL because `deleteStandalonePreview` does not exist.

- [ ] **Step 3: Implement repository deletion minimally**

Inside `createUiPreviewRepository`:

```ts
function deleteStandalonePreview(previewId: string) {
  const transaction = database.transaction(() => {
    const preview = requirePreview(previewId);
    if (preview.taskId) {
      throw new UiPreviewError(
        'UI_PREVIEW_DELETE_LINKED_CONFLICT',
        `UI preview '${previewId}' is linked to task '${preview.taskId}' and cannot be deleted from the Preview Library.`,
      );
    }
    const revisionCount = countRevisions(previewId);
    database.prepare('DELETE FROM ui_previews WHERE id = ?').run(previewId);
    return { previewId, deleted: true as const, deletedRevisions: revisionCount };
  });
  return transaction();
}
```

Expose it in the returned repository type/object. Do not edit migration `016-ui-previews.ts`.

- [ ] **Step 4: Add service/route/client RED tests**

Service test: standalone success shape and linked conflict propagation.

Route test override must include `delete`. Exercise loopback `DELETE /api/ui-previews/uip_route`; assert success JSON, missing 404, linked conflict 409, and Host/access policy behavior consistent with collection mutation safety.

Client test:

```ts
await deleteUiPreview('uip-1');
assert.equal(calls[0].method, 'DELETE');
assert.equal(calls[0].path, '/api/ui-previews/uip-1');
```

- [ ] **Step 5: Implement service/route/client**

Add:

```ts
function remove(input: { previewId: string }) {
  const previewId = String(input.previewId || '').trim();
  if (!previewId) throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', 'previewId is required.');
  return deps.repository.deleteStandalonePreview(previewId);
}
```

Expose service method under the name `delete` (or `remove` internally with `delete: remove` externally) so route overrides can pick it.

Route:

```ts
app.delete('/api/ui-previews/:previewId', strictLocal, (req, res) => {
  try {
    if (!isLoopbackHostHeader(req.headers.host)) throw createApiError(403, 'UI_PREVIEW_LOCAL_ONLY', 'UI preview deletion requires a loopback Host header.');
    return res.json(previewService.delete({ previewId: req.params.previewId }));
  } catch (error) {
    return sendApiError(res, apiErrorForUiPreview(error));
  }
});
```

Client imports `apiDelete` and calls it directly.

- [ ] **Step 6: Run focused deletion tests GREEN**

```bash
npx tsx --test tests/server/uiPreviewRepository.test.ts tests/server/uiPreviewService.test.ts tests/server/uiPreviewRoutes.test.ts tests/client/uiPreviewClient.test.ts
```

- [ ] **Step 7: Commit deletion slice**

```bash
git add src/server/domain/uiPreview.ts src/server/repositories/uiPreviewRepository.ts src/server/services/uiPreviewService.ts src/server/routes/uiPreviews.ts src/client/uiPreviewClient.ts tests/server/uiPreviewRepository.test.ts tests/server/uiPreviewService.test.ts tests/server/uiPreviewRoutes.test.ts tests/client/uiPreviewClient.test.ts
git commit -m "[DVF-0506] feat: add safe preview deletion"
```

---

### Task 2: Preview Change Events and Non-destructive Library Refresh

**Files:**
- Modify: `src/server/services/serverEventService.ts`
- Modify: `src/lib/serverEvents.ts`
- Modify: `src/server/repositories/uiPreviewRepository.ts`
- Modify: `src/components/UiPreviewLibraryPage.tsx`
- Test: `tests/server/serverEventsClient.test.ts`
- Test: `tests/server/serverEventPublishing.test.ts`
- Test: `tests/components/uiPreviewLibraryPage.test.tsx`

**Interfaces:**
- Adds event type `'ui-preview.changed'` on server/client.
- Preview repository publishes after committed create, revision append, bind, and standalone delete.
- Library subscribes and calls a background reload that does not enter initial loading state.

- [ ] **Step 1: Write event type/publication RED tests**

Extend client EventSource test to assert a `ui-preview.changed` native event is registered/dispatched.

Extend publication tests so successful preview create/update/bind/delete publish `{ type: 'ui-preview.changed', entityId: previewId, reason: 'created' | 'updated' | 'bound' | 'deleted' }`; failed linked delete publishes nothing.

- [ ] **Step 2: Run event tests RED**

```bash
npx tsx --test tests/server/serverEventsClient.test.ts tests/server/serverEventPublishing.test.ts
```

- [ ] **Step 3: Add canonical event type and repository publication**

Add `'ui-preview.changed'` to `ServerDomainEventType`, client `ServerEventType`, and `EVENT_TYPES`.

In preview repository, publish only after successful database mutation. Use compact payload:

```ts
publishServerEvent('ui-preview.changed', {
  entityId: previewId,
  reason: 'created',
});
```

For transaction-based operations, publish after the transaction returns successfully so rollback/conflict paths cannot emit success invalidation.

- [ ] **Step 4: Write Library RED tests for hidden IDs/delete/live refresh**

Extend `tests/components/uiPreviewLibraryPage.test.tsx` to assert:

```ts
assert.doesNotMatch(html, /uip-1/);
assert.match(html, /Delete/);           // standalone
assert.doesNotMatch(linkedHtml, /Delete/);
assert.match(untitledHtml, /Untitled preview/);
```

Add source/behavior coverage proving reactive code subscribes to `ui-preview.changed`, event refresh retains current items while the request is pending, and current filter generation wins over stale event responses. Preserve existing StrictMode mounted-reset assertion.

- [ ] **Step 5: Implement Library delete and silent refresh**

Change title fallback:

```ts
return item.title || screen || 'Untitled preview';
```

Add per-preview pending delete state and confirmation. Use the project’s existing confirmation pattern if available; otherwise use one explicit local confirmation UI, not an implicit delete.

Refactor load to accept UI mode:

```ts
type LoadMode = 'initial' | 'manual' | 'background' | 'append';
```

For `background`, do not clear items and do not set full-page `loading=true`; still use the existing request gate.

Subscribe in an effect:

```ts
return subscribeServerEvents((event) => {
  if (event.type !== 'ui-preview.changed') return;
  void load('background', null);
});
```

Manual Refresh remains explicit and may show a compact refreshing state, but must not blank the list.

Standalone card delete success filters the item from state immediately; failure leaves it and writes per-card feedback.

- [ ] **Step 6: Run Library/event tests GREEN**

```bash
npx tsx --test tests/server/serverEventsClient.test.ts tests/server/serverEventPublishing.test.ts tests/components/uiPreviewLibraryPage.test.tsx
```

- [ ] **Step 7: Commit reactive Library slice**

```bash
git add src/server/services/serverEventService.ts src/lib/serverEvents.ts src/server/repositories/uiPreviewRepository.ts src/components/UiPreviewLibraryPage.tsx tests/server/serverEventsClient.test.ts tests/server/serverEventPublishing.test.ts tests/components/uiPreviewLibraryPage.test.tsx
git commit -m "[DVF-0506] feat: refresh preview library reactively"
```

---

### Task 3: Batched Board `hasUiDesign` Signal and Reactive Evidence Attach

**Files:**
- Modify: `src/server/repositories/taskUiEvidenceRepository.ts`
- Modify: `src/server/repositories/taskRepository.ts`
- Modify: `src/server/routes/taskRouteSupport.ts`
- Modify: `src/types.ts`
- Modify: `src/components/TaskCard.tsx`
- Test: `tests/server/taskUiEvidenceBoardPayload.test.ts`
- Test: `tests/server/taskUiEvidenceService.test.ts`
- Test: `tests/taskCardSubtasksUi.test.ts`

**Interfaces:**
- Adds optional `Task.hasUiDesign?: boolean`.
- Board payload includes only `hasUiDesign`, never evidence/source objects.
- Evidence repository exposes bounded current-evidence summary for a set of task ids, or task repository injects the boolean via an `EXISTS`/join in the board query.
- Successful inserted/superseded evidence publishes `task.changed`; same-revision/stale replay does not create a false new-design signal.

- [ ] **Step 1: Write Board payload RED tests**

Extend `taskUiEvidenceBoardPayload.test.ts` so a rich task with `hasUiDesign: true` yields exactly the boolean in `board` mode while still proving serialized payload excludes `uiEvidence`, `uiDesignEvidence`, HTML/CSS/source fields.

Add database-backed coverage around board query: false before evidence insert, true after current evidence exists, and one board query returns all task booleans without per-task repository calls.

- [ ] **Step 2: Run Board tests RED**

```bash
npx tsx --test tests/server/taskUiEvidenceBoardPayload.test.ts
```

- [ ] **Step 3: Implement bounded design summary**

Preferred SQL shape in board query or one helper:

```sql
CASE WHEN EXISTS (
  SELECT 1
  FROM task_ui_evidence e
  WHERE e.task_id = tasks.id
    AND e.is_current = 1
) THEN 1 ELSE 0 END AS hasUiDesign
```

Parse to boolean and expose only in `mode === 'board'` response:

```ts
hasUiDesign: Boolean(task.hasUiDesign),
```

Do not add evidence arrays or URLs to board mode.

- [ ] **Step 4: Add evidence-change publication RED test**

In `taskUiEvidenceService.test.ts`, subscribe/reset server events, attach first evidence, and assert one `task.changed` event for the canonical task id. Replayed same-revision idempotency must not generate an extra semantic evidence-change event.

- [ ] **Step 5: Implement committed task invalidation**

Publish `task.changed` after `recordEvidence` returns `inserted` or `superseded`; resolve project id in one query if available so App’s active-project filtering works.

Preferred central location is immediately after the evidence transaction succeeds (repository or evidence service), not before screenshot/evidence persistence.

- [ ] **Step 6: Write/implement TaskCard badge**

RED render test:

```ts
const withDesign = renderTaskCard({ hasUiDesign: true });
assert.match(withDesign, />Design</);
const withoutDesign = renderTaskCard({ hasUiDesign: false });
assert.doesNotMatch(withoutDesign, />Design</);
```

Implement compact icon+label near existing metadata/category badges:

```tsx
{task.hasUiDesign && (
  <span className="inline-flex items-center gap-1 ..." aria-label="Task has UI Design">
    <ImageIcon size={10} /> Design
  </span>
)}
```

It must be a `span`, not a button/link; pointer behavior remains owned by the task card.

- [ ] **Step 7: Run Board/badge/evidence tests GREEN**

```bash
npx tsx --test tests/server/taskUiEvidenceBoardPayload.test.ts tests/server/taskUiEvidenceService.test.ts tests/taskCardSubtasksUi.test.ts
```

- [ ] **Step 8: Commit Board design slice**

```bash
git add src/server/repositories/taskUiEvidenceRepository.ts src/server/repositories/taskRepository.ts src/server/routes/taskRouteSupport.ts src/types.ts src/components/TaskCard.tsx tests/server/taskUiEvidenceBoardPayload.test.ts tests/server/taskUiEvidenceService.test.ts tests/taskCardSubtasksUi.test.ts
git commit -m "[DVF-0506] feat: surface task design presence"
```

---

### Task 4: Single Frozen Design Action in Task Overview

**Files:**
- Modify: `src/components/taskDrawer/UiDesignEvidenceSection.tsx`
- Test: `tests/components/uiDesignEvidenceSection.test.tsx`
- Test: `tests/components/taskInspectorTabs.test.tsx`

**Interfaces:**
- Frozen screenshot is wrapped by one safe anchor targeting `frozenPreviewUrl`.
- No `Open Preview` button for the current frozen revision.
- `Open Latest` remains only for newer mutable revision.

- [ ] **Step 1: Rewrite component RED expectations**

For evidence with screenshot + frozen URL:

```ts
assert.match(html, /href="http:\/\/127\.0\.0\.1:3000\/previews\/a\/2"/);
assert.match(html, /Open Design/);
assert.doesNotMatch(html, />Open Preview</);
assert.match(html, />Open Latest</);
```

For `latestRevision === frozenRevision`, assert neither `Open Latest` nor duplicate frozen button is present, while the screenshot remains clickable.

For missing `screenshotUrl` or missing frozen URL, assert no misleading `Open Design` click target is emitted.

- [ ] **Step 2: Run UI Design tests RED**

```bash
npx tsx --test tests/components/uiDesignEvidenceSection.test.tsx tests/components/taskInspectorTabs.test.tsx
```

- [ ] **Step 3: Implement clickable frozen screenshot**

Current evidence card should use:

```tsx
{item.screenshotUrl && item.frozenPreviewUrl ? (
  <a
    href={item.frozenPreviewUrl}
    target="_blank"
    rel="noopener noreferrer"
    className="group relative block cursor-pointer ..."
    aria-label={`Open Design: ${title}`}
  >
    <img ... />
    <span className="..."> <ExternalLink size={13} /> Open Design </span>
  </a>
) : item.screenshotUrl ? (
  <img ... />
) : null}
```

Remove current-card `Open Preview`. Keep `Open Latest` in the info/actions area only when newer.

Older revision history can retain its existing historical open link unless the current code would create duplicate current action; scope does not redesign history.

- [ ] **Step 4: Run UI Design tests GREEN**

```bash
npx tsx --test tests/components/uiDesignEvidenceSection.test.tsx tests/components/taskInspectorTabs.test.tsx
```

- [ ] **Step 5: Commit Task Overview slice**

```bash
git add src/components/taskDrawer/UiDesignEvidenceSection.tsx tests/components/uiDesignEvidenceSection.test.tsx tests/components/taskInspectorTabs.test.tsx
git commit -m "[DVF-0506] feat: make frozen design screenshot actionable"
```

---

### Task 5: Cross-slice Regression and Final Verification

**Files:**
- Verify all files changed by Tasks 1-4.
- Update DVF-0506 checklist/evidence only after fresh verification.

**Interfaces:**
- No new production interface; this task proves the combined state.

- [ ] **Step 1: Run all focused DVF-0506 tests**

```bash
npx tsx --test \
  tests/server/uiPreviewRepository.test.ts \
  tests/server/uiPreviewService.test.ts \
  tests/server/uiPreviewRoutes.test.ts \
  tests/server/serverEventsClient.test.ts \
  tests/server/serverEventPublishing.test.ts \
  tests/server/taskUiEvidenceBoardPayload.test.ts \
  tests/server/taskUiEvidenceService.test.ts \
  tests/client/uiPreviewClient.test.ts \
  tests/components/uiPreviewLibraryPage.test.tsx \
  tests/components/uiDesignEvidenceSection.test.tsx \
  tests/taskCardSubtasksUi.test.ts \
  tests/components/taskInspectorTabs.test.tsx
```

Expected: all pass.

- [ ] **Step 2: Run typecheck**

```bash
npm run typecheck
```

Expected: exit 0.

- [ ] **Step 3: Run production build**

```bash
npm run build
```

Expected: exit 0.

- [ ] **Step 4: Inspect final diff for scope**

Confirm:

- no worker/agent prompt files changed,
- migration `016-ui-previews.ts` unchanged,
- no preview source serialized into board payload,
- no Task Detail header `Open Design`,
- no F5/high-frequency polling code,
- no unrelated files.

- [ ] **Step 5: Update DVF-0506 checklist and commit any final test-only cleanup**

If cleanup is needed:

```bash
git add <only DVF-0506 files>
git commit -m "[DVF-0506] test: verify preview design workflow"
```

- [ ] **Step 6: Finalize through DevFlow**

Use task-owned commit/finalize workflow with the exact fresh test/typecheck/build evidence. Integrate locally into `develop`, mark DVF-0506 done, remove safe workspace/branch, and do not push.
