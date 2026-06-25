# DevFlow Architecture Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the DVF-0188 architecture foundation by creating the architecture doc, the baseline behavior inventory, and 12 focused child cards each merging one architectural boundary into `develop` while preserving all existing behavior.

**Architecture:** Layer-by-layer decomposition. Frontend adopts MVVM (UI → ViewModel → Repository → API client). Backend adopts Clean Architecture (Transport → Controller → UseCase → Service → Repository → DB). Each child is one PR, one squash commit, one narrowly-scoped layer introduction or migration. Incremental caller migration via adapter shims so `App.tsx` and `routes/tasks.ts` keep direct API calls until each view-model/controller replaces them.

**Tech Stack:** TypeScript, React 19, Vite, Express, better-sqlite3, existing `npm run` scripts (`typecheck`, `verify`, `test:sqlite`, `test:agent-runs`, `test:import-tasks`, `test:prompt-templates`, `test:orchestration`, `smoke-multi-sse`, `lint`), DevFlow MCP `create_task`, `update_task`, `move_task_status`, `assign_agent`, `get_task`.

## Global Constraints

These rules apply to every task in this plan. They are copied verbatim from `docs/superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md`.

- **Compatibility-first:** All existing REST endpoints, MCP tool contracts, MCP/SSE/proxy behavior, optimistic UI/polling, agent lifecycle, auto-work, queue continuation, prompt rendering, and legacy `designImage`/`designImages`/`images` handling must remain unchanged unless a child task explicitly states a migration.
- **Naming convention:** Frontend hooks `use<X>ViewModel`, repositories `<X>Repository`, mappers `<X>Dto` ↔ `<X>`. Backend controllers `<x>Controller.ts`, use cases `<x>UseCases.ts`, transports `<x>Transport.ts`.
- **Dependency direction:** Frontend UI → ViewModel → Repository → API client → fetch. Backend Transport → Controller → UseCase → Service → Repository → DB. Domain types live at the center.
- **Branch strategy:** Each child uses nested branch `refactor/devflow-clean-architecture-foundation/<feN|beN>-<short-name>`. Merged into `develop` one at a time. Each PR = 1 squash commit.
- **File-overlap rule:** Each child touches at most 3-4 files and must not overlap with an open sibling PR.
- **Verification gate (per child):** `npm run typecheck`, `npm run verify`, `npm run test:sqlite`, `npm run test:agent-runs`, `npm run test:import-tasks`, `npm run test:prompt-templates`, `npm run test:orchestration`, `npm run lint`. Children touching MCP/SSE/proxy/bootstrap (`BE1`, `BE4`, plus `FE3` if it touches proxying) must additionally pass `npm run smoke-multi-sse`.
- **UI manual smoke (per UI-touching child):** Load board + switch active project; create/edit/delete/search/filter tasks; drag/drop across lanes; open/close drawer + edit/save/discard + checklist toggle + subtask + image upload + agent config change + run history + retry; settings + skills + prompt template + JSON import + batch import; exercise MCP tools list/search/get/create/update/move/checklist/assign/agent-context/prompt.
- **Rollback:** Each child PR is independently revertible. If a later child breaks behavior introduced by an earlier child, the later child is fixed or reverted — not the earlier one.
- **DVF task management:** Every child uses DevFlow MCP `create_task` (with `parentId` = parent internal id `task-1781684051905-796512`) before starting work, and `complete_agent_run` (or `move_task_status` to `done`) when finished.
- **TDD discipline:** Where the child introduces testable behavior, write the failing test first, watch it fail, write minimal code, watch it pass, then commit.

## Phase 0 — Foundation

### Task 0: Architecture foundation doc + baseline behavior inventory

**Files:**
- Create: `docs/devflow-architecture-foundation.md`
- Create: `docs/superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md` (already created and committed in DVF-0188 phase 0 prep; reference it from the new doc)
- Modify: none

**Interfaces:**
- Consumes: existing `docs/superpowers/specs/2026-06-17-devflow-architecture-foundation-design.md`
- Produces: `docs/devflow-architecture-foundation.md` which is the card-facing doc referenced by every child card

- [ ] **Step 1: Create DevFlow child card `DVF-0188a`**

Run from `C:\Users\tatar\Projects\dev-flow`:

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Architecture foundation doc + baseline behavior inventory",
    "parentId": "task-1781684051905-796512",
    "branch": "refactor/devflow-clean-architecture-foundation/foundation-arch-doc",
    "status": "in-progress",
    "priority": "high",
    "tags": ["architecture","foundation","docs","DVF-0188"],
    "targetFiles": ["docs/devflow-architecture-foundation.md"],
    "reasoning": "Foundation deliverable for DVF-0188 parent. Pure documentation + baseline inventory. No code changes.",
    "acceptanceCriteria": "- docs/devflow-architecture-foundation.md exists and is linked from the design spec.\n- The doc references the design spec for full architecture map.\n- Baseline behavior inventory covers board load, project switch, task CRUD, lane moves, checklist toggle, drawer edit/save, images/attachments, settings, skills/templates, import/export, MCP tools, SSE/proxy, and agent-run lifecycle.\n- Verification commands listed in the doc exactly match the design spec Section 8.",
    "verification": "npm run typecheck && npm run lint"
  }'
```

Expected: 201 with task payload including `displayId: "DVF-0188a"`.

- [ ] **Step 2: Write the architecture foundation doc**

Create `docs/devflow-architecture-foundation.md` with the following sections:

1. **Purpose & scope** — link to spec, summarize parent card goal.
2. **Architecture map** — copy the dependency diagram from spec Section 5 (with attribution).
3. **Frontend boundaries** — copy spec Section 4.1 table.
4. **Backend boundaries** — copy spec Section 4.2 table.
5. **Naming conventions** — copy from spec Global Constraints.
6. **Child card index** — list all 12 children with branch names and one-line scope.
7. **Migration order** — copy spec Section 7 phases.
8. **Verification matrix** — copy spec Section 8 commands.
9. **Compatibility rules** — copy spec Global Constraints compatibility-first clause.
10. **References** — link to design spec.

- [ ] **Step 3: Validate the doc renders cleanly**

Run: `npm run typecheck && npm run lint`
Expected: PASS (the doc is markdown, no TS impact; `typecheck` only confirms no broken imports).

- [ ] **Step 4: Manual review checklist**

Verify in the rendered markdown:
- No "TBD" / "TODO" / placeholder text
- Dependency diagram is fully visible (ASCII art preserved)
- All 12 children listed with correct branch names matching spec Section 6
- All verification commands match spec Section 8 exactly

- [ ] **Step 5: Commit**

```bash
git add docs/devflow-architecture-foundation.md
git commit -m "docs(DVF-0188a): architecture foundation + baseline behavior inventory"
```

- [ ] **Step 6: Update DevFlow card `DVF-0188a`**

Run:

```bash
# toggle the foundation-doc checklist item
curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188a/checklist/toggle \
  -H "Content-Type: application/json" \
  -d '{"checklistId":"architecture-foundation-doc"}'

# toggle baseline inventory
curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188a/checklist/toggle \
  -H "Content-Type: application/json" \
  -d '{"checklistId":"baseline-behavior-inventory"}'

# mark DVF-0188a done (it owns these two parent checklist items)
curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188a/move \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

Expected: each call returns 200, the parent DVF-0188 shows two more checklist items complete, and DVF-0188a status is `done`.

## Phase 1 — Frontend foundation (new layer, no caller migration)

### Task 1 (FE1): Typed API client

**Files:**
- Create: `src/client/apiClient.ts`
- Modify: none (additive only)

**Interfaces:**
- Consumes: existing `src/server/contracts/devflowContract.ts` types (already used by MCP server for shared request/response shapes)
- Produces: `apiClient.fetchJson<T>(method, path, body?)` returning `{ data: T; correlationId: string; durationMs: number }`; helpers `apiGet`, `apiPost`, `apiPut`, `apiDelete`; `ApiError` class with `code`, `message`, `retryable`, `correlationId`

- [ ] **Step 1: Create DevFlow child card `DVF-0188-FE1`**

Run:

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Typed API client",
    "parentId": "task-1781684051905-796512",
    "branch": "refactor/devflow-clean-architecture-foundation/fe1-api-client",
    "status": "todo",
    "priority": "high",
    "tags": ["architecture","frontend","api-client","DVF-0188"],
    "targetFiles": ["src/client/apiClient.ts"],
    "description": "Introduce src/client/apiClient.ts with typed fetch wrapper, correlation ids, error normalization. No caller changes in this child.",
    "reasoning": "First safe frontend boundary. Additive only. App.tsx/drawer keep existing fetch calls.",
    "acceptanceCriteria": "- src/client/apiClient.ts exports apiClient.fetchJson, apiGet, apiPost, apiPut, apiDelete and ApiError.\n- Correlation ids added via x-correlation-id header.\n- Error normalization matches MCP server error shape {code,message,retryable,correlationId}.\n- Existing direct fetch calls in App.tsx / TaskDetailsDrawer.tsx are NOT touched in this child.",
    "verification": "npm run typecheck && npm run verify && npm run lint"
  }'
```

Expected: `displayId: "DVF-0188-FE1"`.

- [ ] **Step 2: Write failing test**

Create `src/client/apiClient.test.ts` (test runner convention per repo — if no existing client tests, follow pattern from `tests/devflow/`):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient, ApiError } from './apiClient';

describe('apiClient.fetchJson', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('returns parsed JSON with correlationId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-correlation-id': 'cid-test' },
      })
    ));
    const result = await apiClient.fetchJson<{ ok: boolean }>('GET', '/api/test');
    expect(result.data).toEqual({ ok: true });
    expect(result.correlationId).toBe('cid-test');
  });

  it('throws ApiError with normalized shape on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'BAD', message: 'no', retryable: false, correlationId: 'cid-x' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })
    ));
    await expect(apiClient.fetchJson('GET', '/api/test')).rejects.toMatchObject({
      code: 'BAD',
      message: 'no',
      retryable: false,
      correlationId: 'cid-x',
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/client/apiClient.test.ts` (or appropriate runner script)
Expected: FAIL — module not found `./apiClient`.

- [ ] **Step 4: Implement minimal apiClient**

Create `src/client/apiClient.ts`:

```typescript
export class ApiError extends Error {
  constructor(public code: string, message: string, public retryable: boolean, public correlationId: string) {
    super(message);
    this.name = 'ApiError';
  }
}

function newCorrelationId() {
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function parseBody(response: Response) {
  const ct = response.headers.get('content-type') || '';
  return ct.includes('application/json') ? response.json() : response.text();
}

export const apiClient = {
  async fetchJson<T>(method: string, path: string, body?: unknown) {
    const correlationId = newCorrelationId();
    const headers: Record<string, string> = { Accept: 'application/json', 'x-correlation-id': correlationId };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const startedAt = Date.now();
    const response = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await parseBody(response);
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      const err = (parsed && typeof parsed === 'object' && 'error' in parsed) ? (parsed as any).error : { code: 'HTTP_ERROR', message: String(parsed), retryable: response.status >= 500, correlationId };
      throw new ApiError(err.code, err.message, err.retryable, correlationId);
    }
    return { data: parsed as T, correlationId, durationMs };
  },
};

export const apiGet = <T>(path: string) => apiClient.fetchJson<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => apiClient.fetchJson<T>('POST', path, body);
export const apiPut  = <T>(path: string, body?: unknown) => apiClient.fetchJson<T>('PUT', path, body);
export const apiDelete = <T>(path: string) => apiClient.fetchJson<T>('DELETE', path);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/client/apiClient.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full verification gate**

Run:

```bash
npm run typecheck
npm run verify
npm run lint
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/client/apiClient.ts src/client/apiClient.test.ts
git commit -m "feat(DVF-0188-FE1): introduce typed API client with correlation ids"
```

- [ ] **Step 8: Merge into develop**

Open a PR from `refactor/devflow-clean-architecture-foundation/fe1-api-client` to `develop`. After CI passes and reviewer approval, squash-merge.

- [ ] **Step 9: Update DevFlow card `DVF-0188-FE1`**

Run:

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188-FE1/move \
  -H "Content-Type: application/json" \
  -d '{"status":"done"}'
```

Expected: 200, card status `done`.

### Task 2 (FE2): Domain types + DTO mappers

**Files:**
- Create: `src/domain/mappers/taskMapper.ts`, `src/domain/mappers/projectMapper.ts`
- Modify: `src/types.ts` (additive — keep legacy fields, add narrow domain types)

**Interfaces:**
- Consumes: `apiClient` from FE1
- Produces: `Task` domain type (single `Image[]`), `toDomainTask(dto)` / `toDtoTask(domain)` functions; legacy `designImage`/`designImages` mappers preserved as deprecated helpers

- [ ] **Step 1: Create DevFlow child card `DVF-0188-FE2`**

Run:

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Domain types + DTO mappers",
    "parentId": "task-1781684051905-796512",
    "branch": "refactor/devflow-clean-architecture-foundation/fe2-domain-mappers",
    "status": "todo",
    "priority": "high",
    "tags": ["architecture","frontend","domain","mappers","DVF-0188"],
    "targetFiles": ["src/domain/mappers/taskMapper.ts","src/domain/mappers/projectMapper.ts","src/types.ts"]
  }'
```

Expected: `displayId: "DVF-0188-FE2"`.

- [ ] **Step 2: Write failing test**

Create `src/domain/mappers/taskMapper.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { toDomainTask } from './taskMapper';

describe('toDomainTask', () => {
  it('unifies legacy designImage/designImages/images into a single images array', () => {
    const dto = {
      id: 'task-1', displayId: 'DVF-0001', title: 't',
      designImage: 'https://x/a.png',
      designImages: ['https://x/b.png'],
      images: [{ absolutePath: '/c.png' }],
    };
    const domain = toDomainTask(dto as any);
    expect(domain.images).toHaveLength(3);
  });

  it('keeps all other task fields intact', () => {
    const dto = { id: 'task-1', displayId: 'DVF-0001', title: 't', status: 'todo', priority: 'high' };
    const domain = toDomainTask(dto as any);
    expect(domain.status).toBe('todo');
    expect(domain.priority).toBe('high');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/domain/mappers/taskMapper.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement mappers**

Create `src/domain/mappers/taskMapper.ts`:

```typescript
export interface DomainImage {
  url?: string;
  absolutePath?: string;
  filename?: string;
  legacy?: boolean;
}

export interface DomainTask {
  id: string;
  displayId?: string;
  title: string;
  description?: string;
  status?: string;
  priority?: string;
  images: DomainImage[];
  [k: string]: unknown;
}

export function toDomainTask(dto: any): DomainTask {
  const images: DomainImage[] = [];
  if (dto?.designImage) images.push({ url: dto.designImage, legacy: true });
  if (Array.isArray(dto?.designImages)) {
    for (const url of dto.designImages) images.push({ url, legacy: true });
  }
  if (Array.isArray(dto?.images)) {
    for (const img of dto.images) images.push(img);
  }
  const { designImage, designImages, ...rest } = dto || {};
  return { ...rest, images } as DomainTask;
}
```

Create `src/domain/mappers/projectMapper.ts` (analogous shape — adapt from existing `src/types.ts`).

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- src/domain/mappers/taskMapper.test.ts`
Expected: PASS.

- [ ] **Step 6: Run verification gate**

Run: `npm run typecheck && npm run verify && npm run lint`
Expected: all PASS (additive changes only).

- [ ] **Step 7: Manual smoke**

Run dev server (`npm run dev`), open board, confirm:
- Tasks render with their existing images
- No console errors related to legacy `designImage`/`designImages`

- [ ] **Step 8: Commit**

```bash
git add src/domain src/types.ts
git commit -m "feat(DVF-0188-FE2): domain types + DTO mappers unifying legacy image fields"
```

- [ ] **Step 9: Merge and close card**

Same PR → squash-merge flow as Task 1 step 8-9.

### Task 3 (FE3): Repositories layer (with 1-2 callers migrated to prove the layer)

**Files:**
- Create: `src/repositories/taskRepository.ts`, `src/repositories/projectRepository.ts`
- Modify: pick 1-2 callers in `App.tsx` (e.g. tasks list fetch, project list fetch) and migrate them through the repository. Limit the diff.

- [ ] **Step 1: Create DevFlow child card `DVF-0188-FE3`**

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks -H "Content-Type: application/json" -d '{
  "title": "Repositories layer (with proof-of-migration)",
  "parentId": "task-1781684051905-796512",
  "branch": "refactor/devflow-clean-architecture-foundation/fe3-repositories",
  "status": "todo",
  "priority": "high",
  "tags": ["architecture","frontend","repositories","DVF-0188"],
  "targetFiles": ["src/repositories/taskRepository.ts","src/repositories/projectRepository.ts","src/App.tsx"]
}'
```

- [ ] **Step 2: Write failing test**

Create `src/repositories/taskRepository.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { taskRepository } from './taskRepository';
import { apiClient } from '../client/apiClient';

vi.mock('../client/apiClient');

describe('taskRepository.list', () => {
  it('calls apiClient.get with /api/tasks', async () => {
    (apiClient.fetchJson as any).mockResolvedValue({ data: { tasks: [] }, correlationId: 'cid', durationMs: 1 });
    await taskRepository.list();
    expect(apiClient.fetchJson).toHaveBeenCalledWith('GET', '/api/tasks');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- src/repositories/taskRepository.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement taskRepository**

Create `src/repositories/taskRepository.ts`:

```typescript
import { apiClient, apiGet } from '../client/apiClient';
import { toDomainTask, DomainTask } from '../domain/mappers/taskMapper';

export const taskRepository = {
  async list(opts: { projectId?: string; status?: string } = {}): Promise<DomainTask[]> {
    const params = new URLSearchParams();
    if (opts.projectId) params.set('projectId', opts.projectId);
    if (opts.status) params.set('status', opts.status);
    const path = `/api/tasks${params.toString() ? `?${params}` : ''}`;
    const { data } = await apiGet<{ tasks: any[] }>(path);
    return (data.tasks || []).map(toDomainTask);
  },
  // add get/create/update/move/checklist/assign signatures as needed by migrated callers
};
```

- [ ] **Step 5: Migrate 1-2 callers in App.tsx**

Identify the existing `fetch('/api/tasks')` and `fetch('/api/projects')` calls. Replace with `await taskRepository.list()` and `await projectRepository.list()`. Limit the diff to these call sites.

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- src/repositories/taskRepository.test.ts`
Expected: PASS.

- [ ] **Step 7: Run verification gate + manual smoke**

```bash
npm run typecheck && npm run verify && npm run lint
```

Manual smoke: load board, confirm task list + project list still render identically.

- [ ] **Step 8: Commit + merge + close card**

Same flow.

## Phase 2 — Frontend view-models & migration

### Task 4 (FE4): Board + project view-models

**Files:**
- Create: `src/viewModels/useBoardViewModel.ts`, `src/viewModels/useProjectViewModel.ts`
- Modify: `src/App.tsx` — migrate board/project state, polling, drag/drop to view-models. Limit diff.

### Task 5 (FE5): Drawer view-model

**Files:**
- Create: `src/viewModels/useTaskDrawerViewModel.ts`
- Modify: `src/components/TaskDetailsDrawer.tsx` — migrate save logic, checklist mutations, image upload/paste through the view-model.

### Task 6 (FE6): Drawer decomposition

**Files:**
- Create: `src/components/taskDrawer/HeaderSection.tsx`, `AgentSection.tsx`, `ChecklistSection.tsx`, `ImageSection.tsx`, `CommentSection.tsx`, `RunHistorySection.tsx` (and per-section hooks if needed)
- Modify: `src/components/TaskDetailsDrawer.tsx` — replace inline sections with the new sub-components. Each sub-component owns its own section-level hook.

### Task 7 (FE7): App shell extraction

**Files:**
- Modify: `src/App.tsx` — turn into composition root that wires view-models to layout components. Move remaining inline layout into `src/components/layout/`.

## Phase 3 — Backend foundation

### Task 8 (BE1): Bootstrap split

**Files:**
- Create: `src/server/bootstrap.ts` (config load, DB init, AppState creation, transport registration)
- Modify: `server.ts` (becomes thin process wrapper calling bootstrap)

### Task 9 (BE2): Task controllers + use cases

**Files:**
- Create: `src/server/controllers/taskController.ts`, `src/server/useCases/taskUseCases.ts`
- Modify: `src/server/routes/tasks.ts` — wrap existing service paths; controllers progressively call use cases for mutations.

### Task 10 (BE3): Agent-run use cases

**Files:**
- Create: `src/server/useCases/agentRunUseCases.ts`
- Modify: `src/server/routes/tasks.ts` — move agent lifecycle logic into use cases.

### Task 11 (BE4): Transport adapters

**Files:**
- Create: `src/server/transports/restTransport.ts`, `mcpTransport.ts`, `sseTransport.ts`, `proxyTransport.ts`
- Modify: `src/server/bootstrap.ts` — wire transports to controllers.

### Task 12 (BE5): Domain type narrowing

**Files:**
- Create: `src/server/domain/task.ts`, `src/server/domain/appState.ts`
- Modify: `src/server/types.ts` — remove duplicated fields; replace with imports from `src/server/domain/`.

## Phase 4 — Parent closeout

### Task 13: Final verification + parent ready-for-review

**Files:**
- Modify: parent card `DVF-0188` checklist via MCP.

- [ ] **Step 1: Confirm all 12 children are `done`**

Run:

```bash
curl -s "http://127.0.0.1:3000/api/tasks?parentId=task-1781684051905-796512&status=done" \
  | jq '.tasks | length'
```

Expected: 12 (excluding `DVF-0188a` which is the foundation deliverable). If less, do not proceed — resolve missing children first.

- [ ] **Step 2: Run full parent verification matrix**

```bash
npm run typecheck
npm run verify
npm run test:sqlite
npm run test:agent-runs
npm run test:import-tasks
npm run test:prompt-templates
npm run test:orchestration
npm run smoke-multi-sse
```

Expected: all PASS.

- [ ] **Step 3: Manual smoke test (full)**

Walk through every item in spec Section 8 manual smoke checklist. Record outcomes in `notes/dvf-0188-final-smoke.md`.

- [ ] **Step 4: Toggle remaining parent checklist items**

```bash
for id in child-task-boundaries create-child-cards frontend-first-boundary backend-first-boundary contract-verification-plan review-child-outputs final-verification-matrix parent-ready-review-gate; do
  curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188/checklist/toggle \
    -H "Content-Type: application/json" \
    -d "{\"checklistId\":\"$id\"}"
done
```

Expected: each call returns 200, parent shows all 10 checklist items complete.

- [ ] **Step 5: Move parent to ready-for-review**

```bash
curl -s -X POST http://127.0.0.1:3000/api/tasks/DVF-0188/move \
  -H "Content-Type: application/json" \
  -d '{"status":"ready-for-review"}'
```

Expected: 200, parent status `ready-for-review`.
