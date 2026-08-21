# ChatGPT Repo-as-Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tracked `.devflow` policy authoritative for ChatGPT managed execution while preserving SQLite compatibility and keeping runtime state local-only.

**Architecture:** Add a strict bounded `.devflow/project.json` reader to `projectGitWorkflowPolicyService`, resolve repo policy before legacy SQLite policy, and freeze the resolved policy into managed workspace metadata. Explicitly track only portable policy files in `.devflow`; all runtime/cache/secret state stays ignored.

**Tech Stack:** TypeScript, Node test runner, Git worktrees, SQLite compatibility layer.

**Spec:** `docs/superpowers/specs/2026-08-21-chatgpt-repo-as-code-design.md`

## Global Constraints

- ChatGPT/@devflowz managed execution only; Codex behavior is unchanged.
- `.devflow/project.json` is authoritative when present and valid.
- Existing SQLite `gitWorkflowPolicy` remains a fallback only when repo policy is absent.
- Existing policy file that is invalid must fail closed; never silently use SQLite.
- Resolve from explicit configured repository/workspace roots, never `process.cwd()`.
- Keep `.devflow` runtime/cache/jobs/secrets ignored.
- No push.

---

### Task 1: Repo policy RED tests

**Files:**
- Modify: `tests/server/projectGitWorkflowPolicyService.test.ts`

**Interfaces:**
- Produces expected API: `loadRepositoryProjectPolicy(root)` and `resolveProjectGitWorkflowPolicy(project, { repositoryRoot })`.

- [ ] Add a test fixture with conflicting SQLite merge policy and `.devflow/project.json` rebase policy; assert repo policy wins.
- [ ] Add absence test proving SQLite remains fallback.
- [ ] Add malformed/unknown-field/symlink/oversize tests proving fail-closed behavior.
- [ ] Add freshness and root-isolation tests.
- [ ] Run only `tests/server/projectGitWorkflowPolicyService.test.ts` and confirm RED because repo policy APIs/precedence do not exist.

### Task 2: Strict repository policy loader

**Files:**
- Modify: `src/server/services/projectGitWorkflowPolicyService.ts`
- Modify: `src/types.ts` only if a narrow repository-policy type improves clarity.

**Interfaces:**
- `loadRepositoryProjectPolicy(root: string): RepositoryProjectPolicy | null`
- `resolveProjectGitWorkflowPolicy(project, options?: { repositoryRoot?: string }): ResolvedGitWorkflowPolicy`

- [ ] Implement exact `.devflow/project.json` lookup with a bounded regular-file/no-symlink check.
- [ ] Parse JSON, require `version: 1`, reject unknown top-level fields, and validate nested `gitWorkflowPolicy` with existing validator.
- [ ] Change resolution order to repo file → SQLite policy → defaults.
- [ ] Do not cache policy contents so edits are reflected without restart.
- [ ] Run focused policy test and confirm GREEN.

### Task 3: Freeze repo policy into managed workspace

**Files:**
- Modify: `src/server/services/sessionWorkspaceService.ts`
- Test existing/new workspace policy fixtures in `tests/server/sessionWorkspaceService.test.ts` if needed.

**Interfaces:**
- Managed `SessionWorkspace.gitWorkflowPolicy` receives the resolved policy from the target repository root during create/reuse validation.

- [ ] Add a failing test proving workspace creation stores repo policy even when SQLite conflicts.
- [ ] Run focused workspace test and confirm RED.
- [ ] Replace direct `validateGitWorkflowPolicy(project.gitWorkflowPolicy)` with repo-first resolution using the project root/target checkout.
- [ ] Preserve existing workspace compatibility and frozen metadata behavior.
- [ ] Run workspace test and confirm GREEN.

### Task 4: Track portable ChatGPT policy files

**Files:**
- Modify: `.gitignore`
- Create: `.devflow/project.json`
- Create: `.devflow/agents.md`
- Create: `.devflow/verification-impact.json`

**Interfaces:**
- `.devflow/project.json` declares current DevFlow `rebase-ff` + task-aware commit/merge templates.
- `.devflow/agents.md` contains only DevFlow/ChatGPT repository guidance and cannot weaken harness/tool authority.
- `.devflow/verification-impact.json` uses the existing declarative schema with conservative mappings.

- [ ] Unignore exactly the three new portable policy files alongside `commands.yaml`; do not unignore directories broadly.
- [ ] Add current DevFlow repository workflow policy.
- [ ] Add concise ChatGPT managed-execution repository guidance.
- [ ] Add conservative verification-impact rules covering docs/config/tests/server shared-contract changes without unsafe omission.
- [ ] Add/adjust tests for impact config and project-start hint behavior where needed.

### Task 5: Combined verification and completion

**Files:** all above plus any focused tests legitimately required by discovered callers.

- [ ] Run one combined focused verification batch covering Git policy service, session workspace/workspace integration policy behavior, project start context, project command/impact config, prompt templates, and `tsc --noEmit`.
- [ ] Inspect final diff for Codex changes, broad `.devflow` exposure, literal repo-name special cases, or unrelated refactors.
- [ ] Complete task checklist.
- [ ] Commit task-owned changes with `[DVF-0704]` policy normalization.
- [ ] Integrate locally into `develop`, finalize task, clean managed workspace, and do not push.
