# DevFlow Architecture Foundation

> Card-facing companion document to the design spec. The full architecture map, dependency direction, child card list, migration order, and verification matrix live in **[`docs/superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md`](superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md)**. Read that first — this doc is the shorter card-facing summary plus the baseline behavior inventory required by DVF-0188.

**Parent card:** DVF-0188 (Overhaul DevFlow architecture with Clean Architecture foundation and child-task split)
**Foundation deliverable:** DVF-0196 (architecture doc + baseline inventory)
**Implementation plan:** [`docs/superpowers/plans/2026-06-17-devflow-architecture-foundation.md`](superpowers/plans/2026-06-17-devflow-architecture-foundation.md)

## 1. Purpose & scope

This is the architecture foundation for the DevFlow overhaul. It establishes the target frontend MVVM boundaries, target backend Clean Architecture boundaries, dependency direction, naming conventions, child card split, migration order, and verification matrix. It does not implement code — code lives in the 12 child cards listed below.

## 2. Architecture map (summary)

Frontend: `UI → ViewModel → Repository → API client → fetch`

Backend: `Transport → Controller → UseCase → Service → Repository → DB`

Bootstrap is the composition root that wires transports to controllers and DB to repositories.

Full diagram and dependency rules: [design spec Section 5](superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md#5-dependency-direction-diagram).

## 3. Frontend boundaries

| Layer | Responsibility | Folder | Naming |
| --- | --- | --- | --- |
| UI components | Render-only, dispatch intents via view-model functions, no fetch | existing `src/components/` + new sub-components in `src/components/taskDrawer/` | PascalCase component |
| View-models / hooks | Screen state, optimistic updates, polling, derived state | `src/viewModels/` | `use<X>ViewModel` |
| Repositories | Endpoint calls + mapper usage | `src/repositories/` | `<X>Repository` |
| DTO ↔ Domain mappers | Convert server JSON to internal domain (unify legacy image fields) | `src/domain/mappers/` | `<X>Dto` ↔ `<X>` |
| Typed API client | `fetch` wrapper, correlation ids, error normalization | `src/client/apiClient.ts` | `apiClient` |
| Domain types | Shared types consumed by UI and mappers | `src/domain/` (or narrowed `src/types.ts`) | PascalCase type |

## 4. Backend boundaries

| Layer | Responsibility | Folder | Naming |
| --- | --- | --- | --- |
| Bootstrap | Composition root: load config, init persistence, create AppState, register transports | `src/server/bootstrap.ts` (new) | `bootstrap` |
| Transports | REST (Express), MCP, SSE, proxy | `src/server/transports/` | `<x>Transport.ts` |
| Controllers / Route adapters | Request/response shaping, validation glue, error mapping | `src/server/controllers/` | `<x>Controller.ts` |
| Use cases | Orchestration, parent-blocker checks, locks, queue continuation, agent lifecycle | `src/server/useCases/` | `<x>UseCases.ts` |
| Services | Existing validation/context/render helpers (narrower scope) | existing `src/server/services/` | unchanged |
| Repositories | DB I/O only, no business logic | existing `src/server/repositories/` | unchanged |
| Domain types | Narrowed `Task`, `AppState`, `AgentRun` | `src/server/domain/` | PascalCase |

`server.ts` becomes a thin process wrapper that calls `bootstrap()`.

## 5. Naming conventions

- Frontend hooks: `use<X>ViewModel`
- Frontend repositories: `<X>Repository`
- Frontend mappers: `<X>Dto` ↔ `<X>`
- Backend controllers: `<x>Controller.ts`
- Backend use cases: `<x>UseCases.ts`
- Backend transports: `<x>Transport.ts`
- Branch naming: `refactor/devflow-clean-architecture-foundation/<feN|beN>-<short-name>`

## 6. Child card index

Each child is one PR, one squash commit, merged sequentially into `develop`. Display IDs reflect creation order in DevFlow (parent + 13 children → 13 child IDs total):

| Plan alias | DevFlow display ID | Branch | Scope |
| --- | --- | --- | --- |
| Foundation | DVF-0196 | `foundation-arch-doc` | This doc + baseline inventory (Phase 0) |
| FE1 | DVF-0197 | `fe1-api-client` | Typed API client |
| FE2 | DVF-0198 | `fe2-domain-mappers` | Domain types + DTO mappers |
| FE3 | DVF-0199 | `fe3-repositories` | Repositories + 1-2 caller proof-of-migration |
| FE4 | DVF-0200 | `fe4-board-project-vm` | Board + project view-models |
| FE5 | DVF-0201 | `fe5-drawer-vm` | Drawer + agent-run view-model |
| FE6 | DVF-0202 | `fe6-drawer-decomposition` | Drawer sub-components |
| FE7 | DVF-0203 | `fe7-app-shell` | App composition root |
| BE1 | DVF-0204 | `be1-bootstrap-split` | Bootstrap + thin `server.ts` |
| BE2 | DVF-0205 | `be2-task-controllers` | Task controllers + use cases |
| BE3 | DVF-0206 | `be3-agent-run-usecases` | Agent-run use cases |
| BE4 | DVF-0207 | `be4-transports` | Transport adapters |
| BE5 | DVF-0208 | `be5-domain-types` | Domain type narrowing |

## 7. Migration order

Phase 0 — Foundation: Foundation card → merge doc + inventory (no code).

Phase 1 — Frontend foundation (new layer, no caller migration): FE1 → FE2 → FE3.

Phase 2 — Frontend view-models & migration: FE4 → FE5 → FE6 → FE7.

Phase 3 — Backend foundation: BE1 → BE2 → BE3 → BE4 → BE5.

After Phase 2 + Phase 3 → full verification matrix → DVF-0188 moves to `ready-for-review`.

Full details and per-step TDD discipline: [design spec Section 7](superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md#7-migration-order).

## 8. Verification matrix (parent)

Run before moving DVF-0188 to `ready-for-review`:

```bash
npm run typecheck
npm run verify
npm run test:sqlite
npm run test:agent-runs
npm run test:import-tasks
npm run test:prompt-templates
npm run test:orchestration
npm run smoke-multi-sse   # because BE1 and BE4 touch bootstrap/transports
```

Per-child verification gate and manual smoke checklist: [design spec Section 8](superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md#8-verification-matrix).

## 9. Compatibility rules

- All existing REST endpoints, MCP tool contracts, MCP/SSE/proxy behavior, optimistic UI/polling, agent lifecycle, auto-work, queue continuation, prompt rendering, and legacy `designImage`/`designImages`/`images` handling must remain unchanged unless a child task explicitly states a migration.
- Each child is independently revertible. If a later child breaks behavior introduced by an earlier child, the later child is fixed or reverted — not the earlier one.
- Each child touches at most 3-4 files and must not overlap with an open sibling PR.

## 10. Baseline behavior inventory

The following behaviors must remain compatible end-to-end. Each child PR is responsible for confirming no regression in any of these areas. The parent card moves to `ready-for-review` only after every behavior below has been exercised against the merged result.

### 10.1 Board & project
- Load board for active project
- Switch active project
- Project selector reflects current project
- Task list renders in correct lanes (Backlog / Todo / In Progress / Ready for Review / Done)

### 10.2 Task CRUD
- Create task via modal
- Edit task via drawer (save / discard)
- Delete task (with confirmation)
- Search tasks by query string
- Filter tasks by status, priority, tag
- Subtask creation (task with `parentId`)

### 10.3 Lane moves
- Drag/drop task across lanes (optimistic update + server confirm)
- Lane move via API (tool `move_task_status`)
- Parent-blocker check prevents invalid moves

### 10.4 Checklist
- Add checklist item
- Toggle checklist item (via API and via MCP `toggle_task_checklist`)
- Remove checklist item
- Checklist state persists across drawer close/reopen

### 10.5 Drawer
- Open drawer for task
- Close drawer (backdrop / empty area / Esc)
- Edit mode → save / discard
- Preview mode → see all sections
- Progressive disclosure sections render correctly
- Multiple rendering modes (preview / edit) coexist

### 10.6 Images & attachments
- Upload image via file picker
- Paste image from clipboard
- View attached images
- Legacy `designImage` (string) field still renders
- Legacy `designImages` (string array) field still renders
- New unified `images` field renders
- Attachment storage path remains compatible (SQLite)

### 10.7 Settings
- Open settings modal
- Change setting (theme, agent config, etc.)
- Setting persists across reload

### 10.8 Skills & templates
- Open skills modal
- List skills
- Read skill content
- Update mutable skill
- Prompt template renders correctly with task context

### 10.9 Import / export
- JSON import (single task patch)
- Batch import via file (MCP `import_tasks_from_file`, dry-run and apply modes)
- Export data
- Settings backup / restore

### 10.10 MCP tools
- `get_capabilities` returns current contract version
- `get_schema` returns task JSON schema
- `list_projects`, `list_tasks`, `search_tasks`, `get_task`, `get_task_images`, `get_task_prompt`
- `create_task`, `update_task`, `batch_upsert_tasks`, `move_task_status`, `toggle_task_checklist`
- `assign_agent`, `list_agent_runs`, `retry_agent_run`, `cancel_agent_run`, `complete_agent_run`
- `list_skills`, `get_authoring_skills`, `get_skill`, `update_skill`
- `list_local_files`, `read_local_file`, `search_local_files`
- `get_git_log`, `get_git_diff`, `get_git_show`, `get_git_status`, `get_git_branch`

### 10.11 SSE / proxy
- MCP SSE session lifecycle works
- Multiple concurrent SSE clients supported (`smoke-multi-sse`)
- External proxy (e.g. ngrok) reaches backend correctly
- CORS preflight handled
- Static + Vite dev middleware still serves frontend

### 10.12 Agent-run lifecycle
- Trigger agent run for task (auto-work or manual)
- Agent run completes and reports back via `complete_agent_run`
- Retry latest failed run
- Cancel active run
- Run history renders in drawer
- Agent log modal opens and shows logs

### 10.13 Auto-work
- Auto-work toggle launches configured agent
- Respects agent / model / effort configuration
- Spawns queue continuation correctly
- Preflight validation (existing from DVF-preflight) blocks bad launches

## 11. References

- Design spec (authoritative): [`docs/superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md`](superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md)
- Implementation plan: [`docs/superpowers/plans/2026-06-17-devflow-architecture-foundation.md`](superpowers/plans/2026-06-17-devflow-architecture-foundation.md)
- Parent card DVF-0188 (in DevFlow board)
- Foundation deliverable DVF-0196 (this doc)
- Child cards: DVF-0197 through DVF-0208
