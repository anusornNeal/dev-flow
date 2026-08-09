# DevFlow Authoring Core

## Purpose
Write concise, implementation-ready DevFlow cards from user intent plus bounded repository evidence. This is the common skill for ordinary card authoring; source-specific, decomposition, execution, and review rules live in specialist skills.

## Non-negotiable rule
Do not guess implementation details that the repository can answer. When a project is known, inspect the current repo before creating or materially rewriting an implementation-ready card. Keep reads bounded to likely files/symbols/tests and current diff evidence.

## Clarification gate
Ask only when a missing product decision materially changes scope, behavior, data contract, or acceptance criteria. Do not ask for information that repo/Jira/Figma evidence can resolve. If the user explicitly delegates reasonable implementation decisions, record the chosen boundary and proceed.

## Bounded repo inspection
Use `get_repo_context_bundle` first when a project is known. Search/read exact targets only when the bundle is insufficient.

Do not scan or read the whole repo by default. Prefer:
- likely target files and symbols,
- direct callers/dependencies,
- nearest tests,
- current branch/diff when relevant.

Stop reading once the card can name focused target files, current behavior, expected change, acceptance criteria, and verification without guessing.

Use `get_project_atlas` as a companion, not a replacement, when the card is architecture/project-structure/onboarding related, targetFiles remain empty or uncertain after the bundle, the task crosses modules/domains, or the user asks for impact, affected files, module boundaries, or read order. Prefer `task-focused` or `diff-impact` when the task/diff is known; use compact/standard only for broad orientation.
Fall back to `get_repo_inspection_index`, `search_local_files`, and `read_local_file` only when the bundle is unavailable or does not identify enough target files/functions. Then read only the matched target files that are needed to confirm the implementation map.

Do not scan or read the whole repo. Start from the Jira/user terms and search only for likely screen names, visible strings, route names, ViewModels, composables, fragments, adapters, mappers, APIs, models, and tests. Read only the smallest set of files needed to identify the implementation path.

Atlas guardrails:
- Do not use Atlas to skip reading exact target files before editing or authoring an implementation map.
- Treat verified Atlas facts as stronger than inferred summaries, and label inferred guidance as inferred in `reasoning` or review notes when it matters.
- If Atlas is stale, freshness metadata conflicts, or key nodes are noisy/generated, say so and use Atlas only for routing/read-order hints.
- Ignore backup/generated/cache nodes when choosing implementation targets unless the task explicitly touches those areas.
- If Atlas suggests files that conflict with explicit card `targetFiles`, do not override them silently; mention the conflict and inspect the exact files before changing scope.
- Keep lean repo-context workflow for simple single-file cards.

Stop repo inspection when you can name:

- the affected screen or flow,
- the likely target files,
- the exact classes, composables, functions, methods, helpers, routes, mappers, or tests involved,
- the current behavior found in code,
- the smallest safe change location,
- the related tests or verification target,
- files/functions that are explicitly out of scope.

If targeted inspection cannot identify likely files/functions, create a blocked/prep card instead of guessing.

## Repository edit policy
- For LLM-authored existing-file changes, prefer Steno Edit or a structured anchored edit; do not synthesize native unified diffs when a guarded structured edit is suitable.
- `safe_edit_local_file` remains a simpler option for a tiny anchored single-file edit.
- `apply_patch` is an exception for an already-existing or trusted native Git unified diff or a documented fallback. `*** Begin Patch` / `*** Update File` is not valid native Git diff input.
- Preserve preview/revision guards, re-read and re-prepare stale source, and never retry the same failed write payload unchanged.

## Implementation map
Implementation-ready cards must connect requirements to concrete code areas. Put this in `repoContext` using a compact form such as:

`Implementation map:`
- `File: <repo-relative path>`
- `Class/function: <symbol when known>`
- `Current behavior: <what exists now>`
- `Expected change: <what this card changes>`

Mention relevant classes, composables, functions, methods, helpers, routes, mappers, or tests when repo evidence identifies them. Keep `targetFiles` aligned with the implementation map.

## Deep analysis before writing
Resolve the implementation delta, not just the feature theme:
- what currently happens,
- what must change,
- what must remain unchanged,
- important failure/empty/loading/boundary cases,
- dependencies and verification evidence.
Do not copy requirement prose into every field.

## Delta rule
A card describes the delta from current behavior. Preserve existing behavior unless the requirement explicitly changes it. When updating an existing card, merge new evidence into the current truth and remove superseded assumptions instead of stacking contradictions.

## Embedded bug thread rule
For defects reported against an existing task, use `open_task_bug` and keep the fix in that task. Do not use `create_task` for feedback that belongs to the existing implementation/review loop.

## Scope rule
One card should represent one coherent implementation boundary. If independent work can be implemented, verified, or reviewed separately, load `06-authoring-decomposition` and split it rather than hiding real work in a long checklist.

## Wording and copy rule
Use observable product/engineering language. Avoid vague verbs such as “support”, “handle”, or “improve” without stating what changes. Preserve exact user-facing copy when the requirement supplies it; otherwise describe behavior rather than inventing final copy.

## Field placement
- `title`: short implementation outcome, not a meeting note.
- `description`: user-visible/engineering behavior and scope delta; do not bury code archaeology here.
- `repoContext`: implementation map, current code findings, dependencies, constraints, and source evidence summary.
- `targetFiles`: focused repo-relative implementation/test paths supported by evidence.
- `checklist`: implementation/verification milestones inside this card, not substitute child cards.
- `acceptanceCriteria`: observable pass/fail outcomes, including important edge behavior.
- `verification`: concrete tests, commands, manual checks, or evidence needed to prove the criteria.
- `reasoning`: why the boundary/approach is appropriate when that context helps future implementers.

## Acceptance criteria
Make criteria observable. Prefer statements that can be proven from UI/API behavior, state changes, generated artifacts, or tests. Include negative behavior when important: what must not happen, what remains unchanged, and how failures are surfaced.

## Verification
Name the smallest relevant verification first. Use focused tests during implementation and fresh/full verification only when risk or milestone policy requires it. Verification text should say what evidence proves the change rather than only “tests pass”.

## Branch rule
Use the card/project branch policy already established for the project. Do not invent a machine-specific path or branch convention inside portable guidance.

## Status rule
Default card status is `backlog`. Do not set `todo` merely because the card is well specified. Move work only when the user/workflow actually queues or starts it.

## Quality gate
Before mutation, ensure the card has enough evidence to implement without rediscovery: focused scope, implementation map when applicable, observable acceptance criteria, and concrete verification. The server-side create/update quality gate is authoritative; do not resend the full card to a separate validation call unless the caller specifically wants diagnostic/preflight feedback.
