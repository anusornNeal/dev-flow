# DevFlow Authoring Core

## Purpose

Create DevFlow cards that a coding agent can execute safely from DevFlow alone.

A DevFlow card is the source of truth. It must contain the requirement, repo context, implementation scope, acceptance criteria, and verification. The agent must not need to reopen Jira, attachments, comments, screenshots, or external specs to understand the task.

## Non-negotiable rule

Do not write cards that say:

```text
Read Jira before coding.
Open the Jira attachment.
Check Jira comments for details.
See sourceUrl for requirement.
```

Instead, extract the useful information from Jira, attachments, comments, subtasks, and repo inspection, then write that information into the card.

## Clarification gate for non-trivial cards

Before creating or substantially rewriting a non-trivial implementation card, run a short user-clarification pass similar to a focused `grill-me` interview.

Read the available Jira, comments, attachments, Figma evidence, existing DevFlow cards, and targeted repo context first. Ask only about decisions that cannot be safely resolved from those sources.

Use the clarification gate when any are true:

- the request affects multiple screens, flows, layers, modules, repositories, or teams,
- parent/child decomposition is likely,
- architecture, navigation, API contracts, state ownership, migration, shared components, sequencing, rollout, or cross-module behavior is involved,
- there are multiple plausible product or implementation directions,
- business rules, edge cases, acceptance criteria, preserved behavior, verification, or out-of-scope boundaries remain materially ambiguous,
- writing the card immediately would require assumptions that could change implementation scope or behavior.

Skip the clarification gate only when all required facts are already explicit, especially for:

- a small embedded bug with clear actual behavior, expected behavior, evidence, and affected area,
- a tiny one-file copy/config change that follows an established project pattern,
- a narrowly scoped task whose Jira, repo evidence, acceptance criteria, and verification are already complete,
- an explicit user instruction to proceed without questions when remaining uncertainty is minor and can be represented safely.

Clarification sequence:

1. Inspect Jira/design/repo/task evidence first.
2. Identify only unresolved decisions that materially affect the card.
3. Ask one short, concrete question at a time.
4. Continue only until goal, boundaries, important rules, preserved behavior, acceptance, and verification are clear enough for an implementation-ready card.
5. Briefly summarize the resolved decisions, then create or update the card.

Question rules:

- Each question must resolve one material product, scope, acceptance, or verification decision.
- Prefer concrete answer choices when the real options are known; otherwise ask for a rule, example, or expected outcome.
- Do not ask broad questions such as “What should the focus be?”, “Anything else?”, or “How do you want it?”
- Do not repeat facts already present in Jira, repo evidence, prior answers, or the conversation.
- Do not ask the user to choose low-level implementation details that established project patterns already answer.
- Stop asking once the card can be written without material assumptions.

Do not create an implementation-ready large card first and ask for clarification afterward. If required decisions remain unresolved, create only a blocked/prep card that records those decisions.

## Figma evidence rule for frontend cards

Any card classified as `frontend`, including frontend child cards split from a parent, must follow and inspect every relevant Figma link supplied by Jira, comments, attachments, the parent card, or the user before the card is considered implementation-ready.

Do not merely copy a Figma URL into `sourceUrl`, `specUrl`, description, reasoning, or repoContext.

Required Figma workflow:

1. Parse the Figma URL to identify the `fileKey` and relevant `nodeId` or node ids.
2. Call `get_figma_file` to confirm file access and basic metadata.
3. Call `get_figma_node` for the exact frame/component nodes relevant to that frontend slice. For large files or heavy frames, fetch one node at a time.
4. Call `get_figma_design_spec` when normalized layout, spacing, typography, color, constraints, text, or asset references are needed.
5. Pull available frame previews, image references, asset references, or design evidence returned by the Figma tools.
6. Use `attach_figma_context_to_task` after card creation or update so the exact `fileKey` and `nodeId` are linked to the frontend card.
7. Summarize the inspected design directly in the card: frame name, states, layout hierarchy, spacing, typography, colors, copy, assets, interactions, responsive behavior, and visual differences relevant to that child card.
8. Include manual visual verification against the same Figma node in `verification` and observable visual outcomes in `acceptanceCriteria`.

When a parent is split into frontend/backend children:

- attach Figma context to every frontend child that owns a distinct screen, component, state, or responsive layout,
- do not attach all Figma nodes only to the parent and leave frontend children without their own visual evidence,
- each frontend child must include only the nodes and images relevant to its own scope,
- backend/data-only children do not need Figma context unless the design defines data-dependent UI rules that affect their contract.

If a Figma link or required node cannot be opened, do not silently mark the frontend card implementation-ready. Report whether the failure is file access, node access, or design-spec extraction, then ask for a corrected link/node or create a blocked/prep card.

A Jira screenshot may supplement Figma evidence but does not replace following an available Figma link unless the user explicitly confirms the screenshot is the final source of truth.

## ChatGPT-authored Project Atlas scan

Use this workflow when the user asks to scan/build/update Project Atlas, asks for a domain map, asks ChatGPT to read a repo and group it, or asks to make Atlas more detailed/accurate.

Atlas source of truth:
- ChatGPT owns the final domains, sub-flows, nodes, edges, summaries, read order, warnings, coverage notes, skipped-area reasons, grouping rationale, and evidence paths.
- Do not use local scanner output, generated graph files, or heuristic grouping as the final source of truth.
- Do not edit source repo files to create Atlas unless the user explicitly asks for repo file changes.
- Save the final authored Atlas through `apply_project_atlas_agent_update`, then confirm with `get_project_atlas_status`.

Preflight:
- Check tool/project readiness and git status before authoring.
- If the working tree is not clean, tell the user what exists and leave unrelated changes untouched.
- Use `get_repo_context_bundle` first when the project is known.
- Read/list local files in stages; do not claim full-file coverage unless a file inventory layer was actually built.

Staged read order:
1. Project identity: README, AGENTS/AI docs, package/build config, settings, architecture or agent-knowledge docs.
2. Directory inventory: source root, UI folders, data/repository, data/model, navigation/routes, DI/config, tests.
3. Runtime entrypoints: manifest/routes, application bootstrap, main host/shell, navigation graphs, DI bootstrap.
4. Feature anchors: ViewModels/controllers/screens, repositories, API services, key models, and nearest tests.
5. Platform coverage: API service, token/session, preferences, local DB/cache, result/network wrappers, shared UI/base utilities.
6. Test coverage: unit/integration/feature/repository/model/mapper test surfaces.

Grouping rules:
- Build a domain-first map, not a raw file tree graph.
- Prefer domains based on product/runtime flow: Runtime/Navigation, Auth, Onboarding, Jobs, Calendar, Income/Payment, Sub-team/Profile/Settings, Data/API/DI, Data Model Coverage, Shared UI/Common, Build/Tests/Ops.
- Use sub-flow or feature-folder nodes for meaningful areas: login, OTP, password, PIN, personal info, OCR, documents, bank, work area/type, new jobs, my jobs, job detail, media upload, quotation, contractor selection, calendar settings, income search/detail, notification, remote config, profile/privacy.
- Use anchor-file nodes for important route files, ViewModels, repositories, repository implementations, API services, DI modules, session/token state, and high-risk helpers.
- Exclude generated/cache/backup/local-secret paths from key nodes, such as `data/backups/`, `dist/`, `node_modules/`, `.git/`, `.devflow/`, `.gradle/`, `.idea/`, and local env/keystore files, unless the user explicitly asks for those areas.
- If the user wants every file covered, create a separate File Coverage Layer instead of making every file a graph node.

Detail levels:
- Overview Atlas: about 50-80 nodes; large domains and entrypoints only.
- Detailed Domain Atlas: about 100-160 nodes; sub-flow, repo, model, and test coverage for main features.
- 10/10 Domain Atlas: about 150-250 nodes; major feature folders, repository families, model clusters, test surfaces, high-risk warnings, and actionable read order.
- Every-file inventory: separate metadata/table layer, not the main graph.

Edges:
- Use edge kinds that help an agent read flow: `routes`, `calls`, `depends-on`, `contains`, `exports`, `reads`, `writes`, `tests`, `related`.
- Every edge should have a short verified fact or reason.
- Connect UI -> ViewModel/controller -> repository -> API/local storage -> model/test where the repo evidence supports it.

Coverage and evidence:
- Coverage notes must say which docs, directories, route graphs, DI files, repos, models, tests, and anchors were inspected.
- Skipped areas must include generated/cache/IDE/local-secret paths when skipped, such as `.gradle/`, `.idea/`, `local.properties`, `keystore.properties`, `env.properties`, generated output, and pre-existing untracked folders.
- Evidence paths must exist in the repo. Do not use nonexistent paths or broad directory evidence when the tool requires file paths.
- Validate that every domain/flow/edge node id exists before saving.

Warnings to include when relevant:
- Atlas is domain-first, not every-file raw scan.
- Central API/service files are high-risk.
- Large domains such as Jobs or Onboarding are high-risk.
- Mode-sensitive managers must be read before changing flows.
- Hybrid UI stacks, such as Compose plus legacy Fragment/XML, must keep changes in the target layer unless migration is requested.
- Tests may be sparse; prefer focused tests plus compile/broader verification.

Final response after saving:
- Report fresh/cache status, node count, edge count, domain count, and authoring state.
- State whether source repo files were changed.
- Summarize major domains covered.
- Be explicit that the Atlas is domain-first and not every-file inventory unless a file coverage layer was built.

Quality bar:
- 7/10: large domains and primary flows are clear, but coverage is thin.
- 8.5/10: useful sub-flow map with main repositories/tests, but some model/repo/profile/platform coverage remains grouped.
- 9.5/10: readable, broad domain/sub-flow/repo/model/test coverage with warnings and read order.
- 10/10: domain-first, readable, broad coverage across major feature folders, repository families, model clusters, test surfaces, risk warnings, skipped-area notes, and actionable read order without reverting to a noisy every-file graph.

## Embedded bug thread rule

When the user says “เปิดบัค”, “open a bug”, reports defects on an existing task, or gives review feedback for a card that already exists, use `open_task_bug` under that task.

Before opening another bug, inspect existing bug threads:

- update or reopen the existing thread when the root cause is the same,
- archive a bug when its assumptions are invalid,
- archive or clearly supersede obsolete guidance when corrected guidance replaces it,
- keep only one current implementation-guidance bug open for the same defect set,
- do not leave contradictory open bugs and expect the implementer to infer which one wins.

Do not use `create_task` unless the user explicitly asks for a separate new card. The current bug guidance must include observed wrong behavior, expected behavior, evidence, related areas, preserved behavior, out-of-scope boundaries, and a copy-ready fix prompt when available.

Small, well-evidenced embedded bugs normally skip the clarification gate. Ask only when actual behavior, expected behavior, impact, reproduction, or intended product behavior is materially unclear.

If the reviewed task was `ready-for-review`, move it back to or keep it in `in-progress` until the embedded bug thread is fixed and verified.

## Required read order

When applicable:

1. For Jira-originated cards, use `get_jira_authoring_bundle` first when available.
2. Read individual Jira issue/comments/subtasks/attachments only when the bundle is unavailable or missing a specific detail.
3. Read attachments if they contain screenshots, videos, logs, designs, wording, or reproduction evidence not already summarized by the bundle.
4. For every `frontend` card with a Figma link, resolve the file/node, fetch the exact nodes and design evidence, pull available frame/image/asset references, and attach the Figma context to that frontend card.
5. Inspect the repo with `get_repo_context_bundle` first when the project is known.
6. Search for affected screens, strings, APIs, mappers, models, routes, tests, and existing patterns only when the bundle is unavailable or insufficient.
7. Read actual target files, not only search snippets or bundle snippets.
8. Check whether a DevFlow card already exists for the Jira key.
9. Apply the clarification gate when the card is non-trivial and material decisions remain unresolved.
10. Create or update the card only after requirement, design evidence, and repo context are understood.

`get_jira_authoring_bundle` returns the issue, comments, attachment metadata, linked issue hints, and existing DevFlow duplicates in one packet. Use individual Jira proxy tools only when the bundle is missing a specific detail.

## Bounded repo inspection

Repo inspection is required for implementation-ready cards, but it must be targeted.

Use `get_repo_context_bundle` first when a project is known. It should provide the starting git status, repo index matches, focused snippets, and optional diff context in one packet. Query with screen names, visible strings, Jira terms, route names, or flow names.

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

Every implementation-ready card that came from Jira or a bug report must include an implementation map in `repoContext`.

Format:

```text
Implementation map:
- File: JobDetailScreen.kt
  Class/function: JobDetailContent / DetailsTabContent
  Current behavior: lower tab content does not reserve navigation bar inset.
  Expected change: apply or propagate bottom system-bar padding for the Details tab content.

- File: JobDetailFragment.kt
  Class/function: edge-to-edge or root inset setup
  Current behavior: confirm whether the host consumes navigation bar insets.
  Expected change: adjust only if the screen-level inset owner is here.

Out of scope:
- Do not change unrelated Job Detail tabs, survey submission logic, or other My Jobs screens unless the same inset owner is shared.
```

Keep the map short. Prefer 2-5 target entries. If the exact function is uncertain, say `likely` and explain what must be confirmed first.

For frontend cards, the implementation map must also identify the relevant Figma frame/component node for each visual slice and summarize the design behavior implemented by the mapped files.

Before calling `create_task` or `update_task` for a `todo`, `in-progress`, or `ready-for-review` card, run `validate_task_quality` when available and fix any errors it reports.

## Fallback rules

If Jira cannot be read and the user did not provide enough detail, do not create an implementation-ready card.

If repo cannot be inspected enough to understand implementation context, do not create an implementation-ready card.

If a frontend card references Figma but the relevant file/node/image evidence cannot be fetched, do not treat it as implementation-ready. Create a blocked/prep card or request a corrected Figma link/node unless the user explicitly designates another final visual source of truth.

Create a blocked/prep card only when the user wants the work preserved but implementation details are missing.

Always be honest about tool failures. Never pretend Jira or repo was read when it was not.

## Deep analysis before writing

Before writing a card, answer these internally:

- What is the user-facing problem?
- What is the current behavior?
- What is the expected behavior?
- What exact behavior changes from what to what?
- What is the smallest safe implementation scope?
- Which screens, files, layers, APIs, models, tests, strings, or flows are involved?
- Which exact classes, composables, functions, methods, helpers, routes, or mappers should the implementer inspect or edit?
- What existing behavior must remain unchanged?
- What is out of scope?
- What tests or manual checks prove completion?
- Is the task too large for one card?
- Are there related Jira issues with the same root cause or implementation?
- Does the clarification gate apply, and if so, which unresolved user decisions remain?
- If this is a frontend card, which exact Figma file/node/images/design states were inspected and attached?

## Delta rule

Every behavior change must state:

- from what,
- to what,
- where it happens,
- which flow is affected,
- examples that prove the rule,
- out-of-scope boundaries,
- behavior that must remain unchanged.

Bad:

```text
Fix button logic.
```

Good:

```text
Change the Job Detail "เริ่มงาน" button date rule:
- Current wrong behavior: future jobStartDate may enable the button while today/past may disable it.
- Expected behavior: future jobStartDate disables the button; today or past jobStartDate enables it.
- Do not change finish-job or document upload actions.
```

## Wording and copy rule

If the task changes text, include the exact wording in the card.

Include:

- source text,
- target text,
- language,
- screen/location,
- formatting, punctuation, newline, spacing requirements,
- whether to reuse or add string resources.

Do not tell the agent to look up wording in Jira, screenshot, comments, or attachments.

## Duplicate Jira merge rule

Merge multiple Jira issues into one DevFlow card when:

- they have the same root cause,
- they affect the same helper/mapper/component,
- one implementation safely fixes all cases,
- separate cards would duplicate work,
- tests should cover all examples together.

Do not merge when:

- implementation areas differ,
- owners/release timing differ,
- business rules differ,
- testing matrix is too different,
- merge would make the card vague or too large,
- parallel work is safer.

When merging:
- put the primary Jira key first in the title,
- include all relevant Jira keys in title/description,
- use primary key in `jiraKey` if only one value is supported,
- include acceptance criteria for every distinct behavior,
- explain the merge in `reasoning`.

## Subtask-first decomposition rule

Default to splitting work into parent/child cards when the request contains more than one independently verifiable implementation slice. Do not hide real subtask work inside a long checklist.

Apply the clarification gate before finalizing parent/child boundaries when ownership, sequence, contract, or integration responsibilities are not already explicit.

Before creating one combined card, explicitly check whether separate child cards would be safer. Split when any child can have its own target files, acceptance criteria, verification, branch, owner, or implementation order.

Strong split triggers:
- frontend plus backend/data/API work,
- multiple screens, tabs, routes, or flows,
- shared foundation plus feature slices,
- refactor or migration plus behavior change,
- tests or tooling work that can be verified independently,
- high-conflict files where parallel work would be risky,
- unclear sequencing where a foundation card should define contracts first.

When splitting:
- create a parent orchestration card for requirement, architecture, child boundaries, integration, and final verification,
- create child cards for each narrow implementation slice,
- keep every parent and child in `backlog` by default unless the user explicitly asks to queue/start implementation,
- give each child focused `targetFiles`, its own acceptance criteria, its own verification, and clear out-of-scope boundaries,
- avoid duplicated sibling target files unless unavoidable; explain unavoidable overlap in `reasoning`,
- parent checklist should manage child creation/integration/review; child checklist should contain implementation steps only for that slice.
- follow and attach the relevant Figma node/image/design context to each frontend child before considering that child implementation-ready.

If tool limits or missing context prevent creating all children immediately, create the parent in `backlog` with a planned child breakdown in `repoContext` and checklist, or return the proposed parent/child set for review. Do not collapse a multi-slice plan into one oversized implementation card just because it is faster.

## Split rule

Split into parent/child cards when work includes:

- multiple screens or flows,
- multiple independent behaviors,
- frontend and backend work that can be separated,
- refactor plus feature/bug fix,
- high merge-conflict risk,
- unclear sequencing or integration risk,
- work that multiple agents can do independently.

Use a parent card for:
- source-of-truth requirement,
- architecture/foundation,
- child boundaries,
- integration points,
- merge/reconcile/final verification.

Use child cards for:
- narrow implementation slices,
- focused target files,
- independent acceptance and verification,
- minimal overlap with sibling files.

Frontend/backend should be split whenever cleanly separable. Use `category: "general"` only when separation is not clean, and explain why in `reasoning`.

## Frontend/backend split rule

Create separate cards when:

- backend API, schema, DTO, mapper, repository, persistence, or data contract work can be changed and verified independently from UI,
- UI can be implemented against an existing, mocked, or clearly defined contract,
- backend behavior can be verified with API/unit/data tests without launching UI,
- frontend and backend work touch different layers, owners, or high-conflict files,
- parallel child work would reduce risk or keep each card focused.

For Android projects:

- `frontend` means Compose, XML, Fragment/Activity hosting, ViewModel UI state, navigation, UI validation, copy, visual state, and screen-level behavior.
- `backend` means API client, DTO/model, mapper, repository, local persistence/cache, feature flags/config, and data/business rule plumbing.
- `general` means parent orchestration, cross-layer integration that cannot be split safely, docs/config, or one tiny atomic change that must edit both sides together.

Use a parent card when one Jira item spans frontend and backend. Parent owns contract, child boundaries, integration risks, and final verification. Child cards must state their boundary and must not duplicate sibling target files unless unavoidable.

For every frontend child created from the split:

- follow all relevant Figma links from Jira, parent context, comments, or attachments,
- fetch the exact frame/component nodes owned by that child,
- pull available frame previews, image references, assets, and normalized design specs,
- attach the Figma context to the child card itself,
- write the exact visual states and interactions into its description, repoContext, acceptanceCriteria, and verification,
- do not rely on the parent card as the only holder of Figma evidence.

Keep one general card only when:

- the change is a small inseparable cross-layer helper,
- the behavior cannot be tested or shipped in frontend/backend slices,
- sequencing requires one atomic commit,
- splitting would create fake boundaries or more risk than clarity.

If keeping one combined card, `reasoning` must say why it was not split and `repoContext` must identify both frontend and backend touch points.

## Branch rule

Normal single-card branches:

```text
fix/qca-3393-start-job-button-date-rule
feature/qca-1234-new-job-filter
chore/qca-1234-refactor-job-detail
```

Orchestrated work:

```text
qca-3400-job-detail-foundation
qca-3400-job-detail-foundation/ui-sticky-tabs
qca-3400-job-detail-foundation/date-rule-tests
```

Parent branch should end with `-foundation`. Child branches should be nested under the parent branch when possible.

## Field placement

### title

For Jira-originated work:

```text
[JIRA-KEY] Verb + object + context
```

For merged Jira work:

```text
[QCA-3393][QCA-3394] Fix start-job date rules on Job Detail
```

### description

Use for product requirement:

- affected screen/flow/module,
- current behavior,
- expected behavior,
- rules/examples,
- exact wording if relevant,
- scope and out-of-scope.

For frontend cards, also include the exact Figma frame/component names, node ids, relevant design states, and image/asset evidence that were inspected.

Do not dump Jira metadata such as reporter, assignee, timestamps, sprint, board, or raw priority.

### repoContext

Use for technical findings:

- implementation map with target files and functions/classes,
- likely files/components,
- current implementation behavior,
- existing helpers,
- existing tests,
- architecture patterns,
- related behavior to preserve,
- risks and warnings.
- for frontend cards, exact Figma fileKey/nodeId mapping and summarized layout/visual behavior for each target component.

Do not repeat repo URL, local path, or branch metadata.

### checklist

Use concrete executable steps.

Good:

```text
- Confirm the current start-job enablement path used by Job Detail.
- Add regression tests for future/today/past start dates.
- Fix the date comparison so future dates disable the start button.
- Verify existing non-start-job actions are unchanged.
```

Bad:

```text
- Read Jira.
- Understand task.
- Fix bug.
- Test.
```

For frontend cards with Figma evidence, include checklist steps to inspect the exact nodes, implement each required state, and verify the result visually against those nodes.

### acceptanceCriteria

Must be observable pass/fail outcomes.

Avoid implementation-only criteria. Put implementation details in checklist or repoContext.

Frontend criteria must include observable visual/state outcomes derived from the inspected Figma nodes, not vague phrases such as “match design.”

### verification

Must prove completion with:

- tests to add/update,
- targeted commands when known,
- manual scenarios,
- regression checks,
- device/OS/app version only when relevant.

For frontend cards, verification must name the exact Figma node/frame used for visual comparison and cover each required UI state, interaction, screen size, or responsive behavior relevant to the card.

If exact command is unknown, ask the agent to run the most targeted available test/build command for affected files/classes.

### targetFiles

Keep focused and short. Prefer filenames only unless duplicate names need partial paths.

Target files must align with the implementation map. Do not list broad directories unless the exact file is unknown after targeted inspection.

Do not include README/playbook/root docs unless the task is documentation or agent-config work.

### sourceUrl

Keep empty by default. Use only when stable, accessible, and truly required.

A Figma URL alone is not sufficient design context for a frontend card; the link must be followed and its relevant node/image/design evidence summarized and attached to the card.

## Status rule

Default card status is `backlog`.

Use:
- `backlog`: default for every newly authored card, draft, parent card, child/subtask card, blocked/prep card, or request phrased as “write/create/update a card”.
- `todo`: only when the user explicitly says the card should be ready for execution, queued, started, assigned for implementation, or moved out of backlog. The card must also pass implementation-ready quality gates.
- `in-progress`: actively being worked.
- `ready-for-review`: implementation finished and needs review.
- `done`: reviewed and accepted.

Do not set `todo` merely because the card is well specified. A card can be implementation-ready and still belong in `backlog` until the user asks to execute it.

## Quality gate

Before creating/updating a card, verify:

- Jira was read or missing Jira is clearly blocked.
- Repo was inspected or missing repo is clearly blocked.
- The clarification gate was applied when the card was non-trivial and material decisions were unresolved.
- Every frontend card with a Figma link followed the link, fetched the exact relevant nodes, pulled available image/asset/design evidence, attached Figma context to that frontend card, and included node-specific visual acceptance and verification.
- Frontend child cards do not rely only on parent-level Figma attachments or summaries.
- The card can be implemented without opening Jira or Figma.
- Title starts with Jira key for Jira-originated work.
- `jiraKey` is filled when applicable.
- Description contains requirement, not metadata dump.
- Exact required wording is included.
- Similar Jira issues were considered for merge.
- Large work was considered for split.
- Repo context contains useful technical findings and an implementation map when implementation-ready.
- Target files are focused.
- Checklist is concrete.
- Acceptance criteria are pass/fail.
- Verification has concrete tests/scenarios.
- Attachments/comments/subtasks are summarized when relevant.
- Scope is narrow enough to avoid over-fixing.
