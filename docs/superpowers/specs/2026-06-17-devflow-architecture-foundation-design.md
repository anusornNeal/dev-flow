# DevFlow Architecture Foundation Design

> Parent card: **DVF-0188** — Overhaul DevFlow architecture with Clean Architecture foundation and child-task split.
> This spec is the architecture map, dependency direction, child-task split, migration order, and verification matrix for the parent card. It is the source of truth referenced by every child card.

## 1. Goal

Rewrite DVF-0188 as the parent/foundation card for a compatibility-first DevFlow architecture overhaul. The parent owns the architecture map, migration order, child-task split, review/merge coordination, and final verification. It must not become one giant refactor PR.

Concretely, the parent card delivers:

1. This architecture foundation document (`docs/devflow-architecture-foundation.md` plus this design spec).
2. A baseline behavior inventory that lists every behavior that must keep working.
3. A child-task split that decomposes the work into 13 focused child cards plus a foundation deliverable.
4. A merge order with verification gates that lets each child merge independently while preserving compatibility.

## 2. Non-goals

- Do not redesign the visual UI in this parent card.
- Do not rename every file at once.
- Do not break REST or MCP contracts.
- Do not perform a large mechanical rewrite without child tasks and verification.
- Do not remove legacy compatibility such as `designImage`/`designImages` handling unless a child task has explicit migration criteria.

## 3. Current-state pain points

Confirmed from filesystem inspection at `C:\Users\tatar\Projects\dev-flow`:

- `src/components/TaskDetailsDrawer.tsx` — 102,177 bytes / ~2,500 lines. Owns drawer UI plus edit state, save logic, checklist mutations, image upload/paste, comments, subtasks, agent config, run history, retry, copy helpers, progressive disclosure, multiple rendering modes.
- `src/server/routes/tasks.ts` — 84,504 bytes / ~2,200 lines. Combines route handlers, validation glue, mutations, parent blockers, agent lifecycle, queue continuation, prompt endpoints, import/batch paths, image handling, and process launch integration.
- `src/App.tsx` — 748 lines. Owns root UI, board state, project state, polling, filters, drag/drop, task CRUD, project CRUD, batch import, settings fetch, and direct REST calls.
- `server.ts` — 359 lines. Mixes server bootstrap, global state/cache loading, Express middleware, route registration, DevFlow MCP/SSE, external proxy setup, dev middleware, static hosting, and process startup.
- `src/types.ts` (118 lines) and `src/server/types.ts` (23 lines) — duplicated or loose typing around `Task` and `AppState`.

Existing repositories already exist under `src/server/repositories/` and services under `src/server/services/`. The pain is that controllers/routes still contain business logic, and components still call `fetch` directly.

## 4. Target architecture

### 4.1 Frontend MVVM boundaries

Dependency direction: **UI → ViewModel → Repository → API client → fetch**

| Layer | Responsibility | Folder | Naming |
| --- | --- | --- | --- |
| UI components | Render-only, dispatch intents via view-model functions, no fetch | existing `src/components/` + new sub-components in `src/components/taskDrawer/` | PascalCase component |
| View-models / hooks | Screen state, optimistic updates, polling, derived state, intent orchestration | `src/viewModels/` | `use<X>ViewModel` |
| Repositories | Endpoint calls + mapper usage, no UI logic | `src/repositories/` | `<X>Repository` |
| DTO ↔ Domain mappers | Convert server JSON to internal domain objects (unify `designImage`/`designImages` → `Image[]`) | `src/domain/mappers/` | `<X>Dto` ↔ `<X>` |
| Typed API client | `fetch` wrapper, correlation ids, error normalization | `src/client/apiClient.ts` | `apiClient` |
| Domain types | Shared types consumed by UI and mappers | `src/domain/` (or narrowed `src/types.ts`) | PascalCase type |

### 4.2 Backend Clean Architecture boundaries

Dependency direction: **Route/Transport → Controller → UseCase → Service → Repository → DB**

| Layer | Responsibility | Folder | Naming |
| --- | --- | --- | --- |
| Bootstrap | Composition root: load config, init persistence, create AppState, register transports | `src/server/bootstrap.ts` (new) | `bootstrap` |
| Transports | REST (Express), MCP, SSE, proxy. Pure adapter, no business logic | `src/server/transports/` | `<x>Transport.ts` |
| Controllers / Route adapters | Express + MCP request/response shaping, validation glue, error mapping | `src/server/controllers/` | `<x>Controller.ts` |
| Use cases | Orchestration, parent-blocker checks, locks, queue continuation, agent lifecycle decisions | `src/server/useCases/` | `<x>UseCases.ts` |
| Services | Existing validation/context/render helpers, narrower scope | existing `src/server/services/` | unchanged |
| Repositories | DB I/O only, no business logic | existing `src/server/repositories/` | unchanged |
| Domain types | Narrowed `Task`, `AppState`, `AgentRun` etc. No duplicated fields | `src/server/domain/` | PascalCase |

`server.ts` becomes a thin process wrapper that calls `bootstrap()`.

## 5. Dependency direction diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                              FRONTEND                                 │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────────┐    dispatches intents                           │
│  │  UI Components  │ ─────────────────────┐                          │
│  │  (existing      │                      ▼                          │
│  │   + new sub)    │            ┌──────────────────────┐             │
│  └─────────────────┘            │   View-Models        │             │
│          ▲                       │   (hooks)            │             │
│          │ renders               │   useBoardViewModel  │             │
│          │                       │   useDrawerViewModel │             │
│          │                       └──────────┬───────────┘             │
│          │                                  │ uses                   │
│          │                                  ▼                          │
│          │                       ┌──────────────────────┐             │
│          │                       │  Repositories        │             │
│          │                       │  TaskRepository      │             │
│          │                       │  ProjectRepository   │             │
│          │                       └──────────┬───────────┘             │
│          │                                  │ uses                    │
│          │                                  ▼                          │
│          │                       ┌──────────────────────┐             │
│          │                       │  DTO ↔ Domain        │             │
│          │                       │  Mappers             │             │
│          │                       └──────────┬───────────┘             │
│          │                                  │ uses                    │
│          │                                  ▼                          │
│          │                       ┌──────────────────────┐             │
│          │                       │  Typed API Client    │             │
│          │                       │  (fetch wrapper)     │             │
│          │                       └──────────┬───────────┘             │
│          │                                  │                          │
└──────────│──────────────────────────────────│──────────────────────────┘
           │              HTTP/JSON           │
           │                                  ▼
┌──────────│──────────────────────────────────────────────────────────────┐
│          │                          BACKEND                              │
├──────────│──────────────────────────────────────────────────────────────┤
│          ▼                                                               │
│  ┌─────────────────┐      routes request to controllers                 │
│  │  Transports     │ ─────────────────────────┐                          │
│  │  REST/MCP/SSE   │                          ▼                          │
│  │  Proxy          │              ┌──────────────────────┐              │
│  └─────────────────┘              │  Controllers          │              │
│                                   │  (route adapters)     │              │
│                                   └──────────┬───────────┘              │
│                                              │ calls                    │
│                                              ▼                          │
│                                   ┌──────────────────────┐              │
│                                   │  Use Cases           │              │
│                                   │  taskUseCases        │              │
│                                   │  agentRunUseCases    │              │
│                                   │  importUseCases      │              │
│                                   └──────────┬───────────┘              │
│                                              │ orchestrates             │
│                                              ▼                          │
│                                   ┌──────────────────────┐              │
│                                   │  Services (existing) │              │
│                                   │  taskService         │              │
│                                   │  agentRunService     │              │
│                                   │  agentLaunchConfig   │              │
│                                   └──────────┬───────────┘              │
│                                              │ uses                     │
│                                              ▼                          │
│                                   ┌──────────────────────┐              │
│                                   │  Repositories (DB)   │              │
│                                   │  taskRepository      │              │
│                                   │  agentRunRepository  │              │
│                                   │  attachmentRepo      │              │
│                                   └──────────┬───────────┘              │
│                                              │                          │
│                                              ▼                          │
│                                   ┌──────────────────────┐              │
│                                   │  better-sqlite3      │              │
│                                   └──────────────────────┘              │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────────┐  │
│  │  Bootstrap (composition root):                                  │  │
│  │   load config → init DB → create AppState → wire transports  │  │
│  │   to controllers → start http/mcp/sse                           │  │
│  └─────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

Rules:

1. Arrows point **inward** (dependencies). UI never reaches API client directly; Controller never touches DB.
2. Domain types live at the center, shared by FE mappers and BE use cases.
3. Bootstrap is the only place that knows about all layers — no business logic there.
4. During migration, `App.tsx` and `routes/tasks.ts` can bypass the new layer via adapter shims.

## 6. Child card list (13 children + 1 foundation deliverable)

Every child is a real DevFlow card created under `DVF-0188` with `parentId` set to the parent's internal id. Branch naming: `refactor/devflow-clean-architecture-foundation/<feN|beN>-<short-name>`. Total: 1 foundation deliverable + 12 children (7 frontend + 5 backend).

### Foundation

- **DVF-0188a — Architecture foundation doc + baseline behavior inventory** — deliverable is `docs/devflow-architecture-foundation.md` plus an inline baseline inventory (board load, project switch, task CRUD, lane moves, checklist toggle, drawer edit/save, images/attachments, settings, skills/templates, import/export, MCP tools, SSE/proxy, agent-run lifecycle).

### Frontend children (7)

- **DVF-0188-FE1 — Typed API client** — new `src/client/apiClient.ts`. No caller changes in this child. Branch: `refactor/devflow-clean-architecture-foundation/fe1-api-client`.
- **DVF-0188-FE2 — Domain types + DTO mappers** — new `src/domain/mappers/`. Unify `designImage`/`designImages`/`images` into a single `Image[]` model. Additive — `src/types.ts` keeps old fields for compatibility.
- **DVF-0188-FE3 — Repositories layer** — new `src/repositories/`. `TaskRepository`, `ProjectRepository`, `AgentRunRepository`, `SkillRepository`, `SettingsRepository`. At most 1-2 callers migrated to prove the layer.
- **DVF-0188-FE4 — View-models: board + project** — new `src/viewModels/useBoardViewModel.ts`, `useProjectViewModel.ts`. Migrate `App.tsx` board/project sections.
- **DVF-0188-FE5 — View-models: drawer + agent-run** — new `src/viewModels/useTaskDrawerViewModel.ts`. Migrate `TaskDetailsDrawer.tsx` top-level sections (save, checklist, image).
- **DVF-0188-FE6 — Drawer decomposition** — split `TaskDetailsDrawer.tsx` into focused sub-components: `HeaderSection`, `AgentSection`, `ChecklistSection`, `ImageSection`, `CommentSection`, `RunHistorySection`. Each section owns its own hook.
- **DVF-0188-FE7 — App shell extraction** — `App.tsx` becomes composition root that wires view-models to layout components.

### Backend children (5)

- **DVF-0188-BE1 — Bootstrap split** — new `src/server/bootstrap.ts`. `server.ts` becomes a thin process wrapper. Behavior identical.
- **DVF-0188-BE2 — Task controllers + use cases** — extract `tasks.ts` route into `src/server/controllers/taskController.ts` + `src/server/useCases/taskUseCases.ts`. Controllers wrap existing services first, then gradually point at use cases.
- **DVF-0188-BE3 — Agent-run use cases** — move agent lifecycle logic from routes to `src/server/useCases/agentRunUseCases.ts`. Controllers unchanged from API perspective.
- **DVF-0188-BE4 — Transport adapters** — extract MCP/SSE/proxy into `src/server/transports/`. Composition root wires transports to controllers.
- **DVF-0188-BE5 — Domain type narrowing** — clean up `src/server/types.ts`, narrow `AppState`, remove duplicated Task fields.

## 7. Migration order

Sequential merge order to minimize conflicts. Each child = 1 PR, 1 squash commit.

### Phase 0 — Foundation
1. `DVF-0188a` → arch doc + baseline inventory → merge to develop (no code changes).

### Phase 1 — Frontend foundation (new layer, no caller migration)
2. `FE1` — API client
3. `FE2` — Domain types + mappers
4. `FE3` — Repositories (with 1-2 callers migrated to prove the layer)

### Phase 2 — Frontend view-models & migration
5. `FE4` — Board/project view-models
6. `FE5` — Drawer view-model
7. `FE6` — Drawer decomposition
8. `FE7` — App shell extraction

### Phase 3 — Backend foundation
9. `BE1` — Bootstrap split
10. `BE2` — Task controllers + use cases
11. `BE3` — Agent-run use cases
12. `BE4` — Transport adapters
13. `BE5` — Domain type narrowing

After Phase 2 + Phase 3 complete → run full verification matrix → parent `DVF-0188` moves to `ready-for-review`.

**File-overlap rule:** Each child touches at most 3-4 files and must not overlap with an open sibling PR to reduce merge conflicts.

**Rollback:** Each child PR is independently revertible. If a later child breaks behavior introduced by an earlier child, the later child is fixed or reverted — not the earlier one.

## 8. Verification matrix

### Per-child (required before merge)

- `npm run typecheck`
- `npm run verify`
- `npm run test:sqlite`
- `npm run test:agent-runs`
- `npm run test:import-tasks`
- `npm run test:prompt-templates`
- `npm run test:orchestration`
- `npm run lint`

Children that touch MCP/SSE/proxy/bootstrap (`BE1`, `BE4`, `FE3` indirectly via repositories) must additionally pass:

- `npm run smoke-multi-sse`

### Manual smoke checklist (per PR that touches UI)

Each UI-touching child PR must include a manual smoke checklist completed by the author:

- Load board + switch active project
- Create/edit/delete/search/filter tasks
- Drag/drop across lanes
- Open/close drawer + edit/save/discard + checklist toggle + subtask + image upload + agent config change + run history + retry
- Settings + skills + prompt template + JSON import + batch import
- Exercise MCP tools: list/search/get/create/update/move/checklist/assign/agent-context/prompt

### Parent verification (before `ready-for-review`)

```bash
npm run typecheck
npm run verify
npm run test:sqlite
npm run test:agent-runs
npm run test:import-tasks
npm run test:prompt-templates
npm run test:orchestration
npm run smoke-multi-sse   # because BE1/BE4 touch bootstrap/transports
```

Plus the manual smoke test listed above. Auto-work must still launch the configured agent with the intended model and effort. Compatibility evidence (screenshots, smoke logs) saved to `notes/` or PR description.

## 9. Compatibility evidence

Each child PR records:

- Before/after file diff summary
- Verification command outputs (paste relevant excerpts)
- Manual smoke checklist with outcomes
- Rollback instruction: which files revert, which behavior returns

The parent card moves to `ready-for-review` only after every child's outputs are reviewed and a final compatibility summary is written in notes/logs.

## 10. Open questions

None at draft time. Future ambiguities (e.g. introducing a state-management library, splitting `Sidebar.tsx`, splitting `TaskCard.tsx`) are out of scope for this parent and belong in their own cards.
