# Verification Preset Guidance

## Purpose
Use this guidance immediately before final repository verification. It helps choose the smallest sufficient evidenced verification preset without inventing commands, bypassing the verification planner, or mutating repository configuration.

## Required flow
1. Call `inspect_project_verification` with the current project/workspace and the complete changed-file set for the frozen candidate.
2. Treat the returned preset catalog as the runnable source of truth. Prefer the existing planner recommendation and its selected/omitted reasons over guessing command names.
3. When a low-cost targeted preset is sufficient, prefer it over broad or full verification. Never use this preference to bypass a SAFE/FULL escalation made by the existing planner.
4. If no adequate preset is evidenced, inspect the real repository build/test structure before proposing a reusable preset. Package scripts, Gradle files/wrappers, and other build evidence may guide investigation, but do not invent executable names or Gradle tasks that were not observed.
5. Preset generation requires explicit user approval and normal guarded repository edits. Do not silently create or rewrite `.devflow/commands.yaml`, `.devflow/commands.json`, `.devflow/verification-impact.json`, build files, or package scripts.
6. Do not create temporary `.cmd`, `.bat`, `.sh`, or other ad-hoc verification scripts as an automatic fallback.

## FULL regression escalation
- Treat FULL as a repository-wide regression escalation, not as routine final verification.
- Require explicit authority before FULL: an explicit user/project request, repository-wide inferred impact, or proof that FULL is the only safe runnable coverage. Generic high risk, missing impact maps, base advancement, finalization, review/DONE, or a narrow-check failure do not authorize FULL by themselves.
- Preserve the planner's concrete FULL authority and reason code in verification evidence (for example `FULL_EXPLICIT_REQUEST`, `FULL_INFERRED_REPOSITORY_WIDE`, or `FULL_ONLY_SAFE_RUNNABLE_COVERAGE`).
- Run narrower affected coverage first when it can prove the changed closure. A real failing narrow check remains a product failure and must not be bypassed by launching FULL.
- Reuse valid exact-revision FULL GREEN evidence instead of spawning an equivalent second FULL process. Failed or timed-out FULL evidence remains debt and must not trigger a blind automatic FULL retry loop.

## Quality signals
- Preset quality is advisory. Use bounded sample count, confidence, learned duration, and failure pressure only as hints that an existing preset may deserve review.
- `none` or `low` confidence means insufficient evidence, not a defect.
- A `review` quality signal may justify suggesting refinement, but never auto-tune or auto-rewrite the preset.
- Verification correctness and risk policy outrank runtime-cost preferences.

## Safety
`inspect_project_verification` is read-only and must not execute a command. Actual checks still run through `run_project_command` (or the repository's existing final-verification workflow) after the final candidate is frozen.
