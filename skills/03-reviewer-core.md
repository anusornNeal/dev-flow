# DevFlow Reviewer Core

## Purpose
This is the canonical ChatGPT policy for reviewing DevFlow cards in `ready-for-review` and for handling review defects on existing tasks. Compatibility reviewer documents are non-authoritative.

`ready-for-review` is an optional human/reviewer workflow lane, not a prerequisite for managed execution finalization. Managed execution may reach `done` directly from authoritative finalization evidence; this reviewer policy applies only when work is deliberately routed into `ready-for-review`.

`ready-for-review` means the implementation needs real inspection. A reviewer must evaluate the actual work and either complete the card or return it to implementation with precise current guidance.

## Core rule
Never approve from card text, checklist state, or an agent summary alone. Inspect implementation evidence: the relevant branch or integrated commit, diff, changed files, tests, related project patterns, active embedded bugs, and requirement evidence needed to judge correctness.

## Requirement authority and implementation evidence
Keep desired behavior separate from evidence about what currently exists.

### Desired requirement authority
When requirements conflict, prefer:
1. Latest explicit user or product-owner clarification.
2. Current approved DevFlow task/specification, Jira requirement/comments, and approved Figma/design evidence.
3. Older requirement summaries.
4. Reviewer inference.

A reviewer assumption must never override a current approved requirement.

### Implementation evidence
Actual repository implementation, branch/diff state, tests, runtime evidence, and established project patterns describe the current system and whether the requested change was implemented correctly.

Repository implementation cannot override the desired requirement merely because current code or an older pattern behaves differently. When current code differs from the approved requirement, judge whether the card correctly implements the required delta.

If the user corrects a reviewer assumption, re-read the affected requirement and implementation evidence, replace contradictory guidance, and retire the invalid assumption instead of stacking another conflicting instruction.

## Required review inputs
Before pass/fail, inspect as applicable:
1. Current task and its latest requirements.
2. Parent task when reviewing a child; required children when reviewing a parent.
3. Active and historical embedded bug threads that may contain corrected or superseded guidance.
4. Assigned branch, managed-workspace commit, or latest relevant integrated commit.
5. Actual diff and changed files.
6. Related project code and tests needed to understand the changed behavior.
7. Checklist, acceptance criteria, verification, `repoContext`, and `targetFiles`.
8. Jira/Figma/specification evidence when the decision depends on those sources.

Use bounded repository context first and expand only where the review decision still lacks evidence.

## Git and integration review
Resolve the repository Git policy before treating branch topology as correct or incorrect. The default policy is `rebase-ff`; an explicit project `merge` policy overrides that default. Confirm commits respect the configured commit message template or the repository commit convention.

For a local or managed-workspace review:
- identify the intended branch or integrated revision;
- confirm the relevant work is inspectable;
- inspect diff and changed files, not only commit messages;
- read nearby helpers, shared components, or tests when correctness depends on them;
- verify no unrelated scope was accidentally included.

Do not require publication/push unless current user or repository policy requires it. Branch placement alone is not a defect when integrated-revision review is explicitly acceptable.

## Checklist and acceptance criteria
Verify every required checklist item against real evidence. Toggle only an item that is actually satisfied. An unchecked or unverifiable required item is not implicitly complete.

Evaluate acceptance criteria as observable outcomes. Include preserved behavior, failure paths, and negative cases when the requirement makes them material.

## Parent and child review
For a parent:
- inspect every required child;
- confirm required child work is complete and integrated;
- verify the combined outcome rather than only each slice independently;
- do not close the parent while a required child or current defect remains unresolved.

For a child:
- read the parent boundary and shared contracts first;
- verify the child stays inside its scope and does not violate parent integration constraints.

Independent sibling children do not become defects merely because they were implemented in parallel.

## Figma and visual review
When visual acceptance depends on an approved Figma source, inspect the exact referenced evidence needed for the card. Compare only properties that belong to the requirement: copy, state, layout, spacing, typography, assets, interactions, or responsive behavior as applicable.

Do not invent pixel-perfect requirements from reviewer preference. Do not approve a visual requirement from a URL alone when the underlying evidence is required and unavailable.

## Terminal-path review
For changes to async helpers, API wrappers, loading or optimistic state, retries, lifecycle behavior, shared base logic, or request ordering, inspect every materially distinct terminal path, such as:
- success;
- business/local error;
- service/global error;
- retry;
- cancel, back, or dismissal;
- duplicate action;
- overlapping or out-of-order requests;
- lifecycle re-entry or stale responses.

Require regression coverage for branches whose behavior is materially different. A test of one error branch does not prove another differently-routed branch.

## Embedded defects
When review finds a defect on the existing task, inspect current bug threads first.
- Update or reopen the existing thread when it is the same root cause.
- Use `open_task_bug` only for a distinct root cause that needs a new embedded thread.
- Retire or supersede invalid guidance rather than leaving contradictory current bugs.
- Do not create a new top-level card unless the user explicitly requests separate work.

A current defect should state observed behavior, expected behavior, evidence, related areas, preserved behavior or scope boundaries, and copy-ready fix guidance.

## Pass criteria
A card passes only when:
- implementation matches the latest approved requirement;
- required acceptance criteria and checklist items are verified;
- required verification evidence is valid;
- parent/child integration is consistent;
- no current unresolved implementation defect remains;
- actual branch or integrated work was inspected;
- no additional coding is required for the card boundary.

Normal pass transition: `ready-for-review -> done`.

## Fail criteria
Return or keep the card in `in-progress` when implementation is incomplete, required evidence is missing, verification fails, scope is wrong, integration is incomplete, a current defect remains, or the implementation cannot be inspected sufficiently to approve.

Normal fail transition: `ready-for-review -> in-progress`.

## Static-review exception
If the user explicitly waives runtime/build/UAT checks, perform the strongest static review possible and identify what remains unverified. Do not claim skipped checks passed. Close only when the explicit waiver and project workflow permit closure.

## Review note
Record enough evidence for the next reader to understand the decision: revision inspected, key checklist/acceptance results, verification result, current defect disposition, and resulting status. Avoid notes such as “looks good” or “needs fix” without evidence.
