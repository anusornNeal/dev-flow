# DevFlow Authoring Execution Specialist

## Purpose
Load this skill when a DevFlow card continues into repository implementation, evidence-driven execution, guarded edits, verification, task-owned commit, managed workspace lifecycle, or recovery.

## Task ownership and managed workspace
Before mutating an existing DevFlow task, establish authoritative ownership. Reuse the task claim already owned by this session or call `claim_task` for the named task. Use only the managed workspace returned by DevFlow.

Do not create or switch to a replacement workspace to bypass a claim, scope conflict, or ownership error. If another session owns the task or overlapping files, stop mutation and resolve ownership first.

## Local file read/write workflow
Start with `get_repo_context_bundle` for the current requirement and workspace. Read only exact files and symbols needed for the change.

For multiple edit targets, prefer `read_file_snippets_batch(includeFileRef=true)` so bounded content, revisions, and edit-ready refs arrive together. For a genuinely single-file target, use `read_local_file(includeFileRef=true)`.

Keep portable metadata repository-relative. Never derive or persist the physical managed-workspace path.

## Guarded edits
Preview before mutation when practical.
- For LLM-authored existing-file changes, prefer `prepare_compact_edit` followed by `apply_prepared_edit` when revision-bound anchored edits fit.
- Apply only the returned prepared plan. If source changes or a plan expires/is consumed, re-read and re-prepare instead of replaying it.
- Use `edit_local_files_batch` as the guarded structured fallback when compact edits are unsuitable.
- Use `write_local_file` for new files or intentional full-file replacements when that is clearer and bounded.
- Reserve `apply_and_verify` for final verification when it can serve as one required check in that batch; do not use it during implementation because it would add intermediate verification.

Revision and hash guards are authoritative. Do not retry the same failed write payload unchanged; inspect the error and change the source revision, anchor, target, payload, or tool strategy.

## Evidence-driven implementation and verification
Use pre-implementation evidence that adds independent information, then implement the whole scope before routine verification.

1. **Feature/change: UNDERSTAND/DESIGN → IMPLEMENT → VERIFY.** Before non-trivial implementation, establish the requested contract, affected boundaries, important edge cases, and implementation shape. Do not manufacture a failing test solely to satisfy a process ritual.
2. **Bug fix: establish bounded defect evidence → IMPLEMENT → VERIFY.** Prefer a deterministic reproduction when it is practical and informative. Accept an existing failing test, focused test, deterministic command, deterministic scenario, runtime log evidence, or other already-valid bounded evidence. A newly authored failing test is not mandatory. If pre-fix reproduction is impractical, unsafe, nondeterministic, or would add no independent information, proceed from the strongest available evidence and record why reproduction was not useful.
3. **IMPLEMENT** — implement the entire required scope to completion. Update code, tests, docs, generated artifacts, and checklist-related implementation as needed. During this phase, do not run intermediate tests, builds, lint, `apply_and_verify`, or other routine verification commands. Static inspection, diffs, and guarded edits are allowed. Pre-implementation defect evidence and minimum recovery verification after a failed final candidate are exceptions.
4. **VERIFY** — only after implementation is complete, first load `verification-preset-guidance` and call `inspect_project_verification` with the frozen candidate's complete changed-file set. Use the inspection result and existing planner recommendation to choose evidenced commands; do not invent commands, auto-write preset config, or create temporary verification scripts. Then enter one final risk-appropriate verification batch. Before final verification fan-out, freeze one frozen candidate/revision. Required final verification checks may run in parallel, but every check must execute against that same frozen candidate. While final verification is active, do not mutate the task workspace or its files. Join all required checks before completion; every mandatory check must succeed. Evidence from another revision or candidate is invalid for final verification.

No intermediate verification is part of the normal implementation flow. If any required final verification check fails, the frozen candidate becomes stale, or infrastructure interrupts the batch, keep the task in progress, fix from the available failure evidence, then run only the minimum recovery verification against a newly frozen candidate. Recovery reruns are exceptions, not an iterative verification loop.

Choose final verification scope by risk:
- **FAST** — focused deterministic checks for low-risk leaf/local changes.
- **SAFE** — broader targeted checks for shared contracts, cross-file behavior, or higher-risk changes.
- **FULL** — repository-wide verification for parent/integration/milestone combined-state proof, explicit repository/project policy, or exceptional standalone risk. FULL is not the normal leaf default.

Do not delete meaningful checks merely to reduce runtime. Record what the pre-implementation evidence and final verification prove, and use fresh final evidence when the closing gate requires it.

## Async tool completion
When an async DevFlow operation returns a durable job id, call `get_tool_job_result` with a bounded wait and continue polling in the same assistant turn until terminal while the tool surface remains available. If connectivity disappears, preserve the job id and recover it after reconnect rather than replaying the mutation.

## Checklist bookkeeping
When several checklist items become complete from the same finished implementation or verification evidence, batch them in one `toggle_task_checklist` call with `checklistIds`. Use the single `checklistId` form when only one item changes. Do not batch speculative items or mark checklist items complete before the supporting work/evidence exists.

## Task-owned commit
Before committing:
- inspect `get_git_status` and the relevant diff;
- never stage another session's work;
- call `plan_task_commit` for execution-owned scope;
- use `commit_task_owned_changes` for task-bound managed workspaces so only files owned by this task/session are committed; generic `commit_git_changes` is forbidden for task-bound workspaces;
- preserve unrelated dirty files exactly as reported by the plan.

Use a conventional commit input and let DevFlow apply the authoritative task/ticket prefix and project commit policy. Resolve the repository Git policy before terminal integration: the default is `rebase-ff`; an explicit `merge` policy overrides it. Preserve the configured commit message template or repository commit convention.

Do not push unless the user explicitly requests publication.

## Preferred terminal path
For continue-until-terminal intent, the authoritative final verification is the handoff boundary. Before launching it, the reasoning agent must choose the conventional commit message and request `run_project_command` with `autonomousTail.enabled=true` plus that non-empty `commitMessage`. Do not ask DevFlow to invent semantic commit text while the reasoning agent is available.

Once authoritative GREEN verification accepts that terminal handoff, deterministic closure is DevFlow-owned: task-owned commit, repository-policy integration/finalization, any required post-integration verification, safe cleanup, and DONE continue without another reasoning-agent mutation call. GREEN verification, a clean commit, pending finalization, or cleanup are not response boundaries after autonomous-tail admission. Resume reasoning only for structured attention or recovery.

Managed closure does not require `submit_task_for_review` or a synthetic `ready-for-review` transition before `done`. Route work to `ready-for-review` only when human/reviewer inspection or an explicit review/publication workflow is actually intended.

Ordinary verification-only, investigation, debugging, or evidence-gathering commands that do not carry terminal completion intent remain non-autonomous and must not unexpectedly commit or finalize work. Failed or stale verification, ownership ambiguity, conflicts, unsafe drift, and cleanup impossibility still stop in structured attention rather than forcing completion.

If no autonomous tail was admitted, or continuation explicitly requires manual recovery, prefer `finalize_task_workspace` as the fallback local terminal flow after the claimed workspace is clean, committed, and required checks pass. It owns repository-policy integration, evidence synchronization, task completion, and safe workspace cleanup when eligible.

If finalization reports `needs-recovery` or cannot prove a safe terminal state, preserve the workspace and inspect it with `inspect_workspace_recovery`. Do not force-clean ambiguous work.

`integrate_workspace` is a recovery fallback, not the normal terminal path for an eligible task finalization. Use the recorded conflict/retry/abort recovery primitives only after inspecting the workspace state, and never overwrite unrelated base work to make integration succeed.

## Multi-session safety
Independent tasks may proceed in parallel when ownership and target scope are disjoint. If another session begins modifying the same target files, stop before further mutation and re-resolve task/workspace ownership. Never reset, delete, or absorb another session's WIP without explicit recovery authority.
