## DevFlow Workflow Rules

- Do not manually move a card to `in-progress` at the start. DevFlow will handle the initial status transition automatically.
- Work on the branch specified by the card.
- If the specified branch does not exist, create a new branch with that name.
- If the card does not specify a branch, use `develop` as the default branch.
- Handle every checklist item or mini task on the card.
- Do not silently skip checklist items. If an item is not applicable, report the reason clearly.
- When implementation is complete, commit the work to the active branch.
- After committing, notify DevFlow that the work is complete.
- Do not move the card to `ready-for-review` manually unless DevFlow explicitly requires it.