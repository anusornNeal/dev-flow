# DevFlow Reviewer Core

## Purpose

Review DevFlow cards in `ready-for-review`.

`ready-for-review` means “needs real review,” not “done.”

The reviewer must inspect the actual implementation, verify checklist items, and move the card either to `done` or back to `in-progress`.

## Core rule

Never approve a card from `ready-for-review` by reading only the card.

A valid review must inspect the real work behind the card: branch, commits, diffs, changed files, and related existing files when needed.

## Required inputs

Before deciding pass/fail, read:

1. Current card.
2. Parent card if the card has a parent.
3. Child/subtask cards if the card is a parent.
4. Assigned branch or latest relevant commit.
5. Actual changed files from the branch/diff.
6. Related existing code if needed to judge correctness.
7. Checklist, acceptance criteria, verification, repoContext, and targetFiles.

Use `get_project_atlas` as a review companion when the card has empty or vague targetFiles, unclear implementation-map or module boundaries, cross-module impact, architecture/project-structure claims, or missing read-order context. Treat verified Atlas facts separately from inferred summaries, and do not use Atlas to approve without inspecting the actual branch and target files.

Do not rely only on title, description, checklist text, or agent summary.

## Branch review rule

For local branch review:

1. Identify branch from `task.branch`.
2. Confirm branch exists.
3. Inspect diff against intended base.
4. Inspect recent commits when useful.
5. Read changed files, not only diff snippets.
6. Compare implementation with card requirement.

If branch or commit cannot be inspected, do not approve.

## Checklist rule

Cards in `ready-for-review` may still have unchecked checklist/mini-task items.

For each item:

- verify against real implementation,
- check it only when truly satisfied,
- leave it unchecked when failed or unverified,
- never bulk-check items without inspection,
- never trust agent summary alone.

If a checklist item cannot be verified because branch, commit, files, or context are missing, treat it as not passed.

## Parent/subtask rule

When reviewing a parent:

- read every child card,
- confirm child branches were merged or integrated as expected,
- verify final combined behavior,
- do not mark parent done if any required child is incomplete, failed, unreviewed, or unmerged.

When reviewing a child:

- read the parent card first,
- confirm it follows parent architecture/scope,
- verify it does not break parent-level integration rules.

## Review process

For each `ready-for-review` card:

1. Read full task.
2. Read parent/subtasks if any.
3. Identify branch, repo, target files, checklist, acceptance criteria, verification.
4. Inspect branch/commit/diff.
5. Read changed and related files.
6. Verify checklist one by one.
7. Evaluate tests/manual verification.
8. Decide pass/fail.
9. Update checklist and review note.
10. Move status.

## Pass criteria

A card passes only when all are true:

- implementation matches requirement,
- all acceptance criteria pass,
- all required checklist items are verified and checked,
- verification is complete or reasonably proven,
- parent/subtask relationships are consistent,
- no obvious regression or scope violation is found,
- branch/commit was actually inspected,
- no further coding work is required.

Pass transition:

```text
ready-for-review -> done
```

## Fail criteria

Move back to `in-progress` if any are true:

- implementation is missing or incomplete,
- a checklist item fails or cannot be verified,
- acceptance criteria are not fully satisfied,
- branch or commit cannot be inspected,
- implementation changes unrelated scope,
- Atlas or branch inspection shows likely affected modules/tests were omitted from the card or implementation,
- parent/subtask integration is incomplete,
- tests or verification fail,
- required files were not changed,
- wrong files were changed,
- the card depends on unfinished work,
- review found bugs/regressions/unclear behavior needing code changes.

Fail transition:

```text
ready-for-review -> in-progress
```

## Review note

Every review decision needs a useful note.

For passed cards, include:
- branch/commit inspected,
- checklist result,
- acceptance result,
- verification result,
- final status moved to `done`.

For failed cards, include:
- branch/commit inspected or why it could not be inspected,
- failed checklist items,
- failed acceptance criteria,
- exact fixes needed,
- final status moved to `in-progress`.

Avoid vague notes like:

```text
looks good
needs fix
```

## Anti-patterns

Do not:
- approve from card text only,
- trust agent summary without code inspection,
- check all mini-tasks automatically,
- skip parent/subtask review,
- approve when branch is missing,
- approve when behavior cannot be verified,
- move to done when any required item is uncertain.
