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

## Local file read/write workflow

Repository edits are a guarded workflow, not a free-form rewrite.

Before reading files:
- Use `get_repo_context_bundle` first when a project is known. Include diff context when current changes may matter.
- Use targeted queries based on task ids, screen names, visible strings, route names, classes, functions, or failing tests.
- Use `read_file_snippets_batch` for several focused ranges, or `read_local_file` for one exact file/range.
- Prefer local reads before remote GitHub/Jira reads unless the user explicitly asks for remote data.

Before writing files:
- Confirm the working tree is clean or understand the existing diff.
- Read the exact target file content or range first; use the returned file revision/hash as a guard when the write tool supports it.
- Choose the lowest-risk write tool:
  - For LLM-authored existing-file changes, default to `prepare_compact_edit` + `apply_prepared_edit` when revision-bound file refs and anchored edits are available; do not synthesize native unified diffs when Steno or a structured anchored edit can express the change safely. Use Steno Edit v1 universal tuples (`R`, `IB`, `IA`, `DB`) and the request-local `s` string table only for strings repeated inside that request. Apply by `editPlanId` only; if a fileRef/plan is stale, expired, consumed, or lost after restart, re-read and re-prepare instead of replaying it.
  - `safe_edit_local_file` is an explicitly allowed simpler path for a tiny anchored single-file edit, especially in a large route, contract, service, or generated-looking file.
  - `edit_local_files_batch` is the guarded fallback for one or more anchored edits; always dry-run first, then apply the same validated intent.
  - `apply_patch` is an exception for an already-existing or trusted native Git unified diff, a trusted generated native Git unified diff, or a documented fallback when Steno/structured anchored editing is unsuitable. Run dry-run/check first. `*** Begin Patch` / `*** Update File` pseudo-patch syntax is not a native Git unified diff and must not be sent to `apply_patch`.
  - `write_local_file` only for new files, generated files, or small full-file replacements where the complete content is known.
- Do not use full-file writes for large source files when an anchored edit is possible.
- Do not retry the same failed write payload unchanged. Read the error, adjust the anchor/context/tool, then try a new payload.
- Steno Edit is transport shorthand, not a source-language dictionary. Do not invent global, repository-specific, or language-specific token dictionaries; fall back to `safe_edit_local_file`, `edit_local_files_batch`, or the narrow `apply_patch` exception when compact preparation is not the clearest safe path.

### Smart verification workflow

Use risk-matched verification instead of rerunning the whole repository after every edit:
- **FAST**: smallest targeted non-FULL evidence during tight edit loops. Semantic duplicates such as equivalent compiler scripts should count once.
- **SAFE**: broader focused checks when shared helpers, contracts, persistence, workflow, or multiple files are affected.
- **FULL**: repository-wide/final integration gate when the card or review requires it. Do not weaken or remove coverage to make FULL faster.
- Prefer `apply_and_verify` when the edit shape is supported and it can safely combine apply + diff + verification.
- Cached/single-flight evidence is acceptable for iterative deterministic checks, but use `forceFresh` when the final review gate requires fresh proof.

After writing files:
- Inspect `get_git_diff` or targeted file snippets before claiming the edit is correct.
- Run the most targeted available verification first; run the broader `test`/`verify` preset when the change touches shared workflow, skill, schema, queue, or repository tooling.
- Commit one small scope at a time. Use `commit_git_changes` dry-run before the real commit, stage only the intended files, and never push.
- If a tool returns a `jobId`, poll status/log/result until the final result is known before continuing.
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
