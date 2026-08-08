# DevFlow Reviewer Core

## Purpose

Review DevFlow cards in `ready-for-review` and review defect feedback on existing cards.

`ready-for-review` means “needs real review,” not “done.” The reviewer must inspect the actual implementation, verify checklist items and acceptance criteria, and move the card either to `done` or back to `in-progress`.

## Core rule

Never approve a card by reading only the card, checklist, or agent summary.

A valid review must inspect the real work: branch, commits, diff, changed files, related existing code, active embedded bugs, tests, and design/business evidence when relevant.

## Evidence hierarchy

When evidence conflicts, use this order:

1. Latest explicit user or product-owner clarification.
2. Current DevFlow card, Jira requirement, approved comments, and attached Figma/design evidence.
3. Actual repository implementation and established project patterns.
4. Reviewer inference or assumption.

Never preserve or create a defect from a lower-priority assumption that conflicts with stronger evidence.

When the user corrects a review assumption:

- re-read the affected code, design, and project pattern,
- update or replace the review guidance,
- archive invalid bug threads,
- archive or clearly supersede obsolete bug guidance,
- keep only one current implementation-guidance bug open for the same defect set.

Do not leave contradictory open bugs and expect the implementer to decide which one is current. If bug-status mutation is unavailable, record the supersession in task reasoning and treat the obsolete bug as non-blocking until it can be archived.

## Required inputs

Before deciding pass/fail, read:

1. Current card.
2. Parent card if the card has a parent.
3. Child/subtask cards if the card is a parent.
4. Active and historical embedded bug threads, especially corrected or superseded guidance.
5. Assigned branch or latest relevant integrated commit.
6. Actual changed files from the branch/diff.
7. Related existing code and project patterns needed to judge correctness.
8. Checklist, acceptance criteria, verification, repoContext, targetFiles, Jira, and Figma/design evidence when applicable.

Use `get_repo_context_bundle` first when the project is known. If the composite tool fails, do not repeat the same payload unchanged; switch to targeted task, git, search, and file reads.

Use `get_project_atlas` only as a review companion when target files, implementation maps, module boundaries, cross-module impact, architecture claims, or read order are vague. Treat verified Atlas facts separately from inferred summaries, and never use Atlas to approve without inspecting actual target files.

For large Figma files, read one node at a time. Separate file-access, node-access, and design-spec failures instead of treating all failures as a connection or permission problem.

For verification evidence, targeted FAST/SAFE checks and valid cached evidence may support iteration, but they do not replace a required final FULL gate. When fresh proof is required for review, run it with `forceFresh` (directly or through the supported smart verification flow) before approval.

## Branch and implementation review

For local branch review:

1. Identify the intended branch or latest relevant integrated commit.
2. Confirm it exists and inspect working-tree state.
3. Inspect diff against the intended base or previous reviewed commit.
4. Inspect recent commits when useful.
5. Read changed files, not only diff snippets.
6. Read the nearest shared helper, component, base class, and tests when the change depends on them.
7. Compare implementation with the corrected current requirement.

If branch or commit cannot be inspected, do not approve.

Branch placement alone is not a defect when the product owner explicitly confirms that integrated-branch review is acceptable.

## Project-pattern rule

Before prescribing a replacement helper, component, dialog, resource, API wrapper, fallback, or navigation behavior, inspect how equivalent flows are implemented elsewhere in the project.

Do not turn any of these into defects when they are explicitly approved:

- intentional no-op behavior,
- native or shared component choice,
- approved fallback behavior,
- destination or architecture choice,
- shared-component scope,
- branch preference.

Do not require a custom UI component merely because Figma dimensions differ from a native component unless pixel-level replacement is explicitly required. Preserve native/shared components when directed and review only requested properties.

## Checklist rule

For each checklist item:

- verify against actual implementation,
- check it only when truly satisfied,
- leave it unchecked when failed or unverified,
- never bulk-check without inspection,
- never trust an agent summary alone.

If an item cannot be verified because branch, commit, files, tests, or context are missing, treat it as not passed.

## Parent/subtask rule

When reviewing a parent:

- read every child card,
- confirm child work is integrated as expected,
- verify final combined behavior,
- do not mark the parent done while a required child is incomplete, failed, unreviewed, unintegrated, or has unresolved current bugs.

When reviewing a child:

- read the parent first,
- confirm parent architecture and scope,
- verify the child does not break parent integration rules.

## Frontend and Figma review rule

When reviewing a frontend card that has a Figma source:

- confirm the exact Figma file and node referenced by the card were fetched during authoring,
- inspect the relevant node or normalized design spec when visual behavior is part of acceptance,
- verify the frontend child contains its own Figma evidence rather than relying only on the parent,
- compare required states, copy, spacing, typography, colors, assets, interactions, and responsive behavior that belong to the card,
- do not approve from a Figma URL alone.

If the Figma node cannot be inspected and visual acceptance depends on it, treat visual verification as incomplete unless the user explicitly designates another final source of truth.

## Terminal-path review rule

When implementation changes an API wrapper, async helper, optimistic state, loading state, retry behavior, error routing, lifecycle callback, or shared base class, review every meaningful terminal path:

- success,
- local/business error,
- service/global error,
- retry,
- cancel, back, or error-screen dismissal,
- duplicate action,
- overlapping or out-of-order requests,
- lifecycle re-entry,
- stale response after a newer state change.

Loading locks, optimistic values, cached content, and one-shot effects must reach a valid final state on every terminal path.

A test covering only a local 400 error does not prove network, 500, or 503 behavior when the shared helper routes service errors differently. Review the helper implementation itself and require focused regression tests for materially different branches.

## Review process

For each review:

1. Read the task, parent/children, current requirement, and embedded bugs.
2. Resolve invalid or superseded guidance before judging implementation.
3. Identify branch, commit, target files, checklist, acceptance criteria, and verification.
4. Inspect branch, commit, diff, changed files, and nearest project patterns.
5. Compare Jira/Figma evidence when the decision is visual or business-rule dependent.
6. Verify checklist and acceptance criteria one by one.
7. Evaluate tests, manual evidence, and terminal paths.
8. Decide pass/fail.
9. Update checklist, bug status, reasoning, and review note.
10. Move status.

## Pass criteria

A card passes only when all are true:

- implementation matches the latest verified requirement,
- all acceptance criteria pass,
- all required checklist items are verified,
- required verification is complete or reasonably proven,
- parent/subtask relationships are consistent,
- no current unresolved implementation bug remains,
- no obvious regression or scope violation is found,
- branch or integrated commit was actually inspected,
- no further coding work is required.

Pass transition:

```text
ready-for-review -> done
```

Do not move a card to `done` while required behavior, active bug guidance, tests, integration verification, or UAT remain unverified.

## Static-review rule

If the user explicitly skips build, tests, or UAT:

- perform the best possible static review,
- label the result as static review,
- distinguish verified implementation facts from unverified runtime behavior,
- leave command/integration/UAT verification pending,
- do not claim tests passed,
- do not close the card as fully done unless the user explicitly waives those gates and the project workflow allows it.

## Fail criteria

Move or keep the card in `in-progress` when any are true:

- implementation is missing or incomplete,
- a checklist item fails or cannot be verified,
- acceptance criteria are not fully satisfied,
- branch or commit cannot be inspected,
- implementation changes unrelated scope,
- affected modules or tests were omitted,
- parent/subtask integration is incomplete,
- tests or verification fail,
- required files were not changed or wrong files were changed,
- the card depends on unfinished work,
- review finds a bug, regression, race, stale-state path, or unclear behavior needing code changes.

Fail transition:

```text
ready-for-review -> in-progress
```

When review finds a defect, inspect existing embedded bug threads first:

- update or reopen the existing thread when the root cause is the same,
- use `open_task_bug` only for a distinct root cause that needs a new embedded bug thread,
- archive invalid or obsolete threads,
- do not create a separate top-level task unless explicitly requested.

Every current bug must include observed behavior, expected behavior, exact evidence, related areas, preserved behavior, out-of-scope boundaries, and a copy-ready fix prompt.

## Review note

Every decision needs a useful note.

For passed cards, include:

- branch/commit inspected,
- checklist and acceptance result,
- verification result,
- resolved bug status,
- final status.

For failed cards, include:

- branch/commit inspected or why unavailable,
- exact failing behavior and terminal path,
- failed checklist or acceptance criteria,
- exact fix required,
- active bug thread used as current guidance,
- final status.

Avoid vague notes such as:

```text
looks good
needs fix
```

## Anti-patterns

Do not:

- approve from card text only,
- trust agent summary without code inspection,
- preserve a bug after its assumptions are disproven,
- create multiple contradictory bugs for the same defect,
- ignore project patterns before prescribing implementation,
- review only success and one local-error path,
- require custom UI when native/shared behavior is explicitly approved,
- skip parent/subtask review,
- approve when branch, design evidence, or behavior cannot be verified,
- move to done while any required item is uncertain.
