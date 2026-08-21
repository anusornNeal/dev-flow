# ChatGPT Repo-as-Code Design

## Goal
Make repository-tracked `.devflow` configuration the authoritative source for ChatGPT/@devflowz managed execution behavior that should travel with a clone, while keeping machine/runtime state local and keeping SQLite project metadata backward-compatible.

## Scope
This design applies to ChatGPT/@devflowz managed execution only. Codex handoff behavior is intentionally unchanged.

## Source-of-truth boundary
Tracked repository policy:
- `.devflow/project.json` — repository workflow policy, initially Git integration and commit/merge templates.
- `.devflow/agents.md` — ChatGPT project-local instructions injected into managed prompts.
- `.devflow/commands.yaml` — repository verification command presets.
- `.devflow/verification-impact.json` — declarative change-impact to verification mapping.

Ignored local/runtime state remains ignored, including `.devflow/cache`, `.devflow/jobs`, `.devflow/runs`, backups, credentials, temporary recovery scripts, and other undeclared `.devflow/*` files.

## Repository policy resolution
`projectGitWorkflowPolicyService` owns a strict bounded reader for `.devflow/project.json`.

Resolution order:
1. If a configured repository/workspace root contains `.devflow/project.json`, validate it and use its `gitWorkflowPolicy` as authoritative.
2. If the repository policy file is absent, fall back to the existing SQLite `Project.gitWorkflowPolicy` for compatibility.
3. If neither exists, use the existing safe defaults.
4. If the repository policy file exists but is malformed, oversized, symlinked, or contains unsupported fields, fail closed with an actionable policy error. Never silently fall back to conflicting SQLite policy.

The resolver must receive an explicit repository/workspace root. It must never use `process.cwd()` as policy authority. Reads are bounded and fresh on each policy resolution so edits are visible without restart.

## Workspace freezing
Managed workspace metadata should store the already-resolved Git workflow policy at workspace creation time. This freezes integration/commit semantics for one claimed execution and prevents a mid-task policy edit from silently changing the finalization contract. New claims pick up the latest repo policy.

## Compatibility
SQLite schema and project API keep the existing optional `gitWorkflowPolicy` field as a legacy fallback. No destructive migration is required. Existing repositories without `.devflow/project.json` behave exactly as before.

## DevFlow repository policy
The DevFlow repository itself tracks:

```json
{
  "version": 1,
  "gitWorkflowPolicy": {
    "integrationStrategy": "rebase-ff",
    "commitMessageTemplate": "[{ticket}] {type}: {title}",
    "mergeMessageTemplate": "Merge {ticket}"
  }
}
```

This encodes the current expected DevFlow behavior in Git instead of relying on machine-local SQLite state.

## Safety
- Repository policy cannot override system/developer instructions, harness hard-safety policy, ownership/fencing, verification gates, or tool contracts.
- Parsing is strict: unknown top-level/project-policy fields are rejected.
- Policy files must be regular non-symlink files and size-bounded.
- No general unignore of `.devflow/`; only explicit tracked policy files are allowed.

## Verification
TDD proves repository policy precedence, legacy fallback, fail-closed invalid policy, root isolation, and no-restart freshness. Existing workspace integration and commit-policy tests prove callers consume the frozen resolved policy. Context/prompt tests prove `.devflow/agents.md` remains ChatGPT-managed input. Verification config tests prove `.devflow/verification-impact.json` remains bounded and fingerprinted. Final combined verification includes focused suites plus TypeScript typecheck.
