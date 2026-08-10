# DVF-0453 Git Workflow Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a repository-level Git workflow policy that defaults to rebase + fast-forward, allows explicit merge topology, and models commit/merge message conventions independently without repository-name conditionals.

**Architecture:** Store one validated JSON policy on each project. A focused policy service owns defaults, parsing, validation, ticket-context resolution, and template rendering; project persistence/routes only transport the value. Workspace integration asks the project policy service for topology and uses `rebase-ff` unless the project explicitly requests `merge`.

**Tech Stack:** TypeScript, Express, better-sqlite3 migrations, Node test runner, Git CLI fixtures.

## Global Constraints

- Default integration strategy is `rebase-ff`.
- Explicit project policy may select `merge`.
- Commit and merge message templates are independent of integration topology.
- Ticket values come from task/project context, never literal repository names or fixed prefixes.
- Existing projects without policy remain valid without migration-time backfill.
- No push.

---

### Task 1: Policy model and renderer

**Files:**
- Modify: `src/types.ts`
- Create: `src/server/services/projectGitWorkflowPolicyService.ts`
- Create: `tests/server/projectGitWorkflowPolicyService.test.ts`

**Interfaces:**
- Produces: `GitWorkflowPolicy`, `ResolvedGitWorkflowPolicy`, `validateGitWorkflowPolicy`, `resolveProjectGitWorkflowPolicy`, `renderGitWorkflowTemplate`, `resolveTaskTicketContext`.

- [ ] Write failing tests for default `rebase-ff`, explicit `merge`, valid `{ticket}/{title}/{type}` templates, Jira key falling back to display id, and invalid strategies/placeholders.
- [ ] Run the focused test and confirm RED.
- [ ] Implement the minimal model/validation/renderer with actionable API errors.
- [ ] Run the focused test and confirm GREEN.

### Task 2: Project persistence and API compatibility

**Files:**
- Create: `src/db/migrations/013-project-git-workflow-policy.ts`
- Modify: `src/db/migrations/index.ts`
- Modify: `src/db/schema.sql`
- Modify: `src/server/repositories/projectRepository.ts`
- Modify: `src/server/routes/projects.ts`
- Create: `tests/server/projectGitWorkflowPolicyRoutes.test.ts`

**Interfaces:**
- Consumes: `validateGitWorkflowPolicy`.
- Produces: project rows with optional structured `gitWorkflowPolicy`.

- [ ] Write route/repository tests proving old projects return no policy, create/update persists structured policy, and invalid policy returns an actionable 400.
- [ ] Run focused tests and confirm RED.
- [ ] Add migration, JSON serialization/deserialization, and route validation.
- [ ] Run focused tests and confirm GREEN.

### Task 3: Repo-aware workspace integration

**Files:**
- Modify: `src/server/services/workspaceIntegrationService.ts`
- Modify: `tests/server/workspaceIntegrationService.test.ts`

**Interfaces:**
- Consumes: `resolveProjectGitWorkflowPolicy(project)`.
- Produces: integration result `strategy` reflecting the resolved project topology.

- [ ] Add failing fixtures for no policy => linear `rebase-ff` and explicit merge policy => merge commit topology.
- [ ] Run focused integration tests and confirm RED for merge override.
- [ ] Resolve the project policy by `workspace.projectId`; keep the existing rebase path as default and add an isolated merge path only for explicit `merge`.
- [ ] Run focused integration tests and confirm GREEN.

### Task 4: Verification and commit

**Files:** all files above.

- [ ] Run TypeScript lint/typecheck.
- [ ] Run policy, project-policy route, and workspace-integration focused suites.
- [ ] Inspect git diff for repository-name/prefix conditionals and unintended changes.
- [ ] Commit with a task-aware DVF message, then integrate into `develop` only after the running DevFlow runtime has loaded DVF-0452 rebase-ff behavior.
