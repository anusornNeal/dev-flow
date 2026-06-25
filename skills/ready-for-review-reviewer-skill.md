# Ready for Review Reviewer Skill

## Purpose

This skill defines how ChatGPT must review DevFlow cards in `ready-for-review`.

The reviewer must verify the actual implementation, not only read the card. Most `ready-for-review` cards may have unchecked mini tasks/checklist items. The reviewer is responsible for checking each item, marking completed items, and moving the card to the correct final status.

## Core Rule

Never approve a card from `ready-for-review` by reading only the card.

A valid review must inspect the real work behind the card, usually through the local git branch, commits, diffs, and affected files.

## Required Review Inputs

Before deciding pass/fail, read:

1. The current card.
2. The parent card, if the card has a parent.
3. All subtasks/child cards, if the card is a parent.
4. The assigned branch or latest relevant commit.
5. The actual changed files from the branch/diff.
6. Existing related code where needed to understand whether the change is correct.
7. The checklist, acceptance criteria, verification, repoContext, and targetFiles.

Do not rely only on title, description, checklist text, or agent summary.

## Ready-for-Review Checklist Rule

Cards in `ready-for-review` may still have unchecked mini tasks.

The reviewer must:

- Check each mini task one by one.
- Verify each item against the actual implementation.
- Mark the item complete only when it is truly satisfied.
- Leave failed or unverified items unchecked.
- Do not bulk-check all items without inspection.

If a checklist item cannot be verified because branch, commit, files, or context are missing, treat it as not passed.

## Branch and Commit Review Rule

For local branch review:

1. Identify the card branch from `task.branch`.
2. Confirm the local branch exists.
3. Read the branch diff against the intended base branch.
4. Read recent commits on that branch when useful.
5. Read changed files, not only diff snippets.
6. Compare implementation with the card requirements.

Use local git inspection whenever available:

- current branch
- target branch
- git log
- git diff
- changed file list
- actual file contents

If the branch is missing or cannot be inspected, do not approve the card.

## Parent and Subtask Rule

If reviewing a parent card:

- Read every child/subtask.
- Check whether child branches were merged or integrated as expected.
- Verify parent acceptance criteria against the combined final state.
- Do not mark the parent done if any required child task is still incomplete, failed, unreviewed, or not merged.

If reviewing a subtask:

- Read the parent card first.
- Confirm the subtask follows the parent’s architecture, branch convention, and scope.
- Verify the subtask did not break parent-level integration rules.

## Step-by-Step Review Process

For each card in `ready-for-review`:

1. Read the full task.
2. Read parent/subtasks if they exist.
3. Identify branch, repo, target files, checklist, acceptance criteria, and verification.
4. Inspect local git branch/commit/diff.
5. Read changed files and related existing files.
6. Check each checklist item.
7. Run or evaluate the required verification steps when possible.
8. Decide pass/fail.
9. Move the card to the correct status.

## Pass Criteria

A card passes only when all are true:

- The real implementation matches the card requirement.
- All acceptance criteria pass.
- All required checklist items are verified and checked.
- Verification is complete or reasonably proven.
- Parent/subtask relationships are consistent.
- No obvious regression, broken code, or scope violation is found.
- The branch/commit was actually inspected.
- The card can be considered complete without further coding work.

If all pass, move the card from `ready-for-review` to `done`.

## Fail Criteria

Move the card back to `in-progress` if any of these are true:

- Implementation is missing or incomplete.
- A checklist item fails or cannot be verified.
- Acceptance criteria are not fully satisfied.
- Branch or commit cannot be inspected.
- The implementation changes unrelated scope.
- Parent/subtask integration is incomplete.
- Tests or verification clearly fail.
- Required files were not changed or the wrong files were changed.
- The card depends on another unfinished card.
- The review found bugs, regressions, or unclear behavior that needs coding work.

When moving back to `in-progress`, update the task with a clear review note explaining exactly what failed and what must be fixed.

## Status Movement Rule

Use these status transitions:

- Pass all checks: `ready-for-review` -> `done`
- Fail any required check: `ready-for-review` -> `in-progress`
- Cannot inspect branch/commit: `ready-for-review` -> `in-progress`

Do not leave a reviewed card in `ready-for-review` unless the user explicitly asks for a partial review only.

## Review Notes Rule

Every review decision must leave a useful note in the task fields or final response.

For passed cards, summarize:

- branch/commit inspected
- checklist result
- acceptance criteria result
- verification result
- final status moved to `done`

For failed cards, summarize:

- branch/commit inspected or why it could not be inspected
- failed checklist items
- failed acceptance criteria
- exact fixes needed
- final status moved back to `in-progress`

## Mini Task Toggle Rule

When a checklist item is verified:

- Toggle only that specific checklist item.
- Do not toggle unrelated checklist items.
- Do not toggle an item just because the agent claimed it was done.
- If a checked item is later found incorrect, update the review note and move the card back to `in-progress`.

## Tool Usage Rule

Use available DevFlow tools where appropriate:

- `Dev_Flow.list_tasks` to find `ready-for-review` cards.
- `Dev_Flow.get_task` to read full card details.
- `Dev_Flow.list_tasks` with `parentId` to read child/subtask cards.
- `Dev_Flow.get_git_branch` to inspect available local branches.
- `Dev_Flow.get_git_log` to inspect commits.
- `Dev_Flow.get_git_diff` to inspect changes.
- `Dev_Flow.read_local_file` to read actual changed files and related files.
- `Dev_Flow.toggle_task_checklist` or batch toggle tools to mark verified checklist items.
- `Dev_Flow.update_task` to write review notes if needed.
- `Dev_Flow.move_task_to_status` to move a card to `done` or `in-progress` through the allowed transition path automatically.
- `Dev_Flow.move_task_status` or batch move tools only when an explicit one-step move or bulk move is needed.

## Anti-Patterns

Do not do these:

- Do not approve from card text only.
- Do not trust agent completion summary without reading code.
- Do not check all mini tasks automatically.
- Do not skip parent/subtask review.
- Do not approve when branch is missing.
- Do not approve when tests are not run and behavior cannot be verified another way.
- Do not move to done when any required item is uncertain.
- Do not create vague review notes like “looks good” or “needs fix”.

## Final Rule

`ready-for-review` means “needs real review,” not “done.”

The reviewer owns the final decision: read the card, inspect the branch, verify every mini task, check parent/subtasks, then move the card either back to `in-progress` or forward to `done`.
