# Task Inspector Subtasks — Compact Two-Column Cards

## 1. Goal

Make the **Subtasks** view inside Task Detail / Task Inspector substantially faster to scan when a parent task has many children, while preserving the current task navigation and copy-ID interactions.

The approved direction is **Option B: compact two-column cards**.

The redesign should reduce wasted vertical space, keep the child task ID and state visible at a glance, and allow more subtasks to fit in the viewport without turning the section into a dense table.

## 2. Current State

`src/components/taskDrawer/SubtasksSection.tsx` already renders subtasks in a responsive two-column grid:

```tsx
<div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 select-none">
```

Each child card currently:

- has a fixed `h-[90px]` height;
- places the ID and title near the top;
- places model / priority and status near the bottom;
- leaves noticeable empty space in the middle when content is short;
- truncates the title to one line;
- uses relatively large card padding and inter-card gaps for a high-volume scanning surface.

The section also shows a separate completion summary above the grid and already renders all child tasks without a five-item limit.

## 3. Approved UX Direction

### 3.1 Layout

Keep the existing responsive card model:

- **Desktop / standard inspector width:** 2 columns.
- **Narrow inspector / small viewport:** 1 column.
- Continue rendering the full child-task collection; do not reintroduce pagination, "show more", or a five-item cap.

Reduce visual density by tightening the grid gap and card padding, but retain enough separation for each subtask to remain visually distinct and clickable.

### 3.2 Card Height

Remove the fixed `h-[90px]` requirement.

Cards should use **content-driven compact height** with no explicit fixed height or minimum height. Let the grid row naturally align sibling cards to the taller content in that row. The intent is to remove the large blank middle area without introducing another height constraint.

The target is a noticeably shorter card than the current 90px presentation for typical subtasks.

### 3.3 Information Hierarchy

Each card should read in this order:

1. **Top row**
   - Child task ID at the left, e.g. `DVF-0510`.
   - Status at the right, using the existing task vocabulary but optimized for scanning:
     - `BACKLOG` / `TODO` for not-started work,
     - `ACTIVE` for `in-progress`,
     - `DONE` for completed work.

2. **Title**
   - Strongest text element after the ID.
   - Allow up to **two lines** instead of forcing a single-line truncation.
   - Long titles may truncate after two lines, but the ID and status must remain fully visible.

3. **Bottom metadata row**
   - Keep only compact secondary metadata that helps distinguish work quickly.
   - Priority remains visible.
   - Keep the existing **model** pill when a model is present, plus the existing **priority** pill. Do **not** add category to the card in this scope. Both should use small, low-emphasis styling so they do not compete with ID, title, and status.
   - Metadata text should remain legible at roughly 9–10px minimum rather than becoming micro-text.

The card should not add new task data or require backend changes.

### 3.4 Completion Summary

Keep the section-level completion summary above the cards, including:

- completed count / total count;
- percentage complete;
- progress bar.

Make the summary itself more compact:

- thinner progress bar;
- reduced vertical padding;
- no oversized empty container around the bar;
- preserve the current calculated percentage behavior.

The section header and **Create Subtask Spec** action remain available when creation is allowed.

### 3.5 Visual States

Keep clear state differentiation without making each card visually noisy:

- **In progress / active:** subtle accent border or highlight so active work is easy to find.
- **Done:** lower contrast than active / backlog cards; completed title may remain struck through if it stays readable.
- **Backlog / todo:** neutral surface.

Avoid large status-colored card backgrounds. Status should primarily be communicated by the compact status pill plus restrained border / text treatment.

Dark mode must preserve the same hierarchy and state readability.

### 3.6 Interaction

Preserve current interactions:

- Clicking anywhere on the card opens / selects that child task through `onSelectTask`.
- Clicking the task ID copies the display ID and must stop propagation so it does not open the task.
- Clickable surfaces retain pointer affordance and existing active / hover feedback.

No new interaction model is required.

## 4. Component Boundaries

### Primary file

`src/components/taskDrawer/SubtasksSection.tsx`

This is the main implementation target. The compact layout should be achieved primarily by adjusting the existing `SubtasksSection` and local `SubtaskCard` structure / classes rather than introducing a new global component.

### Related files

`src/components/TaskDetailsDrawer.tsx`

- Preserve the existing Subtasks tab behavior.
- Do not change tab visibility rules except where required by existing tests.

`src/components/TaskCard.tsx`

- No visual redesign is required for board TaskCard subtasks as part of this work.
- Only touch this file if a shared behavior or test contract genuinely requires it.

## 5. Scope

### In scope

- compact two-column subtask card presentation in Task Inspector;
- reduced vertical whitespace;
- two-line child titles;
- top-row ID + status hierarchy;
- compact model + priority metadata;
- compact completion summary;
- responsive 2-column → 1-column behavior;
- dark-mode parity;
- preserving child navigation and copy-ID interaction;
- focused regression tests for the new markup / layout contract.

### Out of scope

- changing subtask ordering;
- changing task state logic;
- adding filtering, sorting, grouping, pagination, or virtualization;
- changing how completion percentage is calculated;
- changing create-subtask behavior;
- redesigning the whole Task Inspector;
- redesigning board-level `TaskCard`;
- backend / API / persistence changes.

## 6. Testing Strategy

Update or extend the existing focused tests rather than creating a broad new suite.

### `tests/taskCardSubtasksUi.test.ts`

Cover at minimum:

- all child tasks remain rendered when there are more than five;
- each child display ID remains visible;
- status labels remain present for representative states;
- no `show more` / `show less` controls are introduced;
- the subtask grid still exposes the responsive 1-column / 2-column contract;
- the old fixed `h-[90px]` card constraint is no longer present;
- title markup supports the intended two-line treatment rather than single-line `truncate`.

### `tests/components/taskInspectorTabs.test.tsx`

Keep existing Subtasks-tab behavior green, especially:

- hide the Subtasks tab when no child tasks exist;
- fall back to Overview when the caller requests Subtasks but no children are available.

### Verification

Run the smallest focused test command covering these files first, followed by the repository's normal frontend build / typecheck verification required by the current DevFlow workflow.

## 7. Accessibility and Readability

- Keep semantic buttons for the copy-ID action and create-subtask action.
- Ensure the entire card remains keyboard/click behavior-compatible with the existing implementation; do not regress existing navigation behavior.
- Do not rely on color alone for status — visible status text remains required.
- Maintain readable contrast in light and dark themes.
- Avoid shrinking critical text below a practical readable size; secondary metadata should remain approximately 9–10px minimum.

## 8. Acceptance Criteria

The design is successful when:

1. Subtasks remain displayed as **two compact columns** at standard inspector width and one column on narrow width.
2. Typical child cards are visibly shorter and contain substantially less empty vertical space than the current fixed 90px cards.
3. Every card exposes **ID at top-left**, **status at top-right**, **title up to two lines**, and compact model + priority metadata below when available.
4. `ACTIVE`, `DONE`, and not-started cards are distinguishable without heavy full-card coloring.
5. The progress summary remains visible but consumes less vertical space.
6. Clicking the card still selects the child task; clicking the ID still copies the ID without selecting the card.
7. More than five children still render without collapsing or show-more controls.
8. Existing Subtasks tab visibility / fallback behavior remains unchanged.
9. Light and dark themes both preserve hierarchy, readability, and status distinction.
10. No backend, persistence, ordering, filtering, or parent/child state logic changes are introduced.
