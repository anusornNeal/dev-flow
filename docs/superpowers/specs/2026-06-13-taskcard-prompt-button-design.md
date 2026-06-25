# TaskCard Prompt Template Button Design

## Goal
Add a convenient way for users to copy the prompt template directly from the `TaskCard` component without having to open the `TaskDetailsDrawer`.

## Context
Currently, the `CopyTemplateButton` is only available inside the `TaskDetailsDrawer`. To improve workflow efficiency for manual agent handoffs, this button should also be accessible directly on the card face.

## Selected Approach
**Icon-only in the Stat Bar (Middle Row)**
The button will be placed next to the Files count and Checklist progress indicators.

### Why this approach?
- **Saves Space:** Using the `variant="icon"` mode of `CopyTemplateButton` keeps the card clean and uncluttered.
- **Semantic Grouping:** The stats row contains quick metadata about the task's state. Placing a quick-action icon here aligns with the minimal visual hierarchy of the card.
- **Clean Aesthetics:** It prevents overcrowding the Agent/Model dropdown row which is already dense.

## Implementation Details
1. **Component Update:** Modify `src/components/TaskCard.tsx`.
2. **Placement:** In the middle row (around line 200), locate the container holding the `<FileCode>` and `<CheckSquare>` stats.
3. **Insertion:** Append `<CopyTemplateButton task={task} variant="icon" className="..." />` inside the stats container.
4. **Styling:** Add minimal padding and transparent/hover background styles to ensure it blends with the other stat badges. Add a `title` prop (if not natively handled by `CopyTemplateButton`) to ensure users understand what the icon does on hover.

## Open Questions / Ambiguities
- Should the button be visible at all times, or only on hover (like the Delete card button)?
  - *Decision:* Visible at all times to ensure discoverability, matching the other stat badges.

## Verification
- Verify the button copies the prompt successfully to the clipboard.
- Verify the layout does not break or overflow when the task has a long title or many files.
