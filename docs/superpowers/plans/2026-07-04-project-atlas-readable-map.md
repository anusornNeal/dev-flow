# Project Atlas Readable Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Project Atlas easier to understand by adding a reader-first inspector and clearer focused dependency map behavior.

**Architecture:** Keep the existing frontend-only Project Atlas flow. Add deterministic reading-path and relationship derivations in `src/lib/projectAtlasViewModel.ts`, then render those fields in `AtlasNodeInspector.tsx` and lightly tune `AtlasGraph.tsx` focus copy and emphasis. No backend contract change is needed.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, lucide-react, Node `node:test` tests run through `tsx`.

---

## File Structure

- Modify `src/lib/projectAtlasViewModel.ts`: extend `AtlasDomainInspectorViewModel` with reader-first fields and derive them from existing atlas nodes, domains, and edges.
- Modify `tests/server/projectAtlasViewModel.test.ts`: add focused tests for start-here file ranking, incoming/outgoing domain separation, and empty-domain resilience.
- Modify `src/components/projectAtlas/AtlasNodeInspector.tsx`: render the Info tab in reader-first order: What This Is, Start Here, Depends On, Used By, Key Files, Technical Details, Copy Context.
- Modify `src/components/projectAtlas/AtlasGraph.tsx`: tune focus-mode status text and emphasis so selected-domain reading is obvious without changing the SVG engine.

## Task 1: View Model Reading Fields

**Files:**
- Modify: `src/lib/projectAtlasViewModel.ts`
- Test: `tests/server/projectAtlasViewModel.test.ts`

- [ ] **Step 1: Add failing tests for inspector reading fields**

Append these tests to `tests/server/projectAtlasViewModel.test.ts`:

```ts
test('buildDomainInspector ranks start-here files before supporting files', () => {
  const inspector = buildDomainInspector(atlas, 'domain:ui-components');

  assert.deepEqual(inspector?.startHereFiles.map((file: any) => file.path), [
    'src/components/App.tsx',
    'src/components/App.css',
  ]);
  assert.equal(inspector?.plainSummary, 'React screens and shared UI composition.');
});

test('buildDomainInspector separates domains this domain depends on from domains that use it', () => {
  const uiInspector = buildDomainInspector(atlas, 'domain:ui-components');
  const testsInspector = buildDomainInspector(atlas, 'domain:tests');

  assert.deepEqual(uiInspector?.incomingDomains.map((domain: any) => domain.name), ['Tests']);
  assert.deepEqual(uiInspector?.outgoingDomains.map((domain: any) => domain.name), []);
  assert.deepEqual(testsInspector?.incomingDomains.map((domain: any) => domain.name), []);
  assert.deepEqual(testsInspector?.outgoingDomains.map((domain: any) => domain.name), ['UI Components']);
});

test('buildDomainInspector handles empty domains with readable defaults', () => {
  const emptyAtlas = {
    ...atlas,
    domains: [
      ...atlas.domains,
      { id: 'domain:empty', name: 'Empty Area', nodeIds: [], origin: 'manual', summary: undefined },
    ],
  };

  const inspector = buildDomainInspector(emptyAtlas, 'domain:empty');

  assert.equal(inspector?.plainSummary, 'Empty Area domain with 0 related Atlas items.');
  assert.deepEqual(inspector?.startHereFiles, []);
  assert.deepEqual(inspector?.incomingDomains, []);
  assert.deepEqual(inspector?.outgoingDomains, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
npx tsx tests/server/projectAtlasViewModel.test.ts
```

Expected: FAIL because `startHereFiles`, `plainSummary`, `incomingDomains`, and `outgoingDomains` do not exist yet.

- [ ] **Step 3: Extend inspector types**

In `src/lib/projectAtlasViewModel.ts`, replace the current `AtlasDomainInspectorViewModel` interface:

```ts
export interface AtlasDomainInspectorViewModel extends AtlasDomainMapNode {
  name: string;
  health: string;
}
```

with:

```ts
export interface AtlasDomainRelationship {
  id: string;
  name: string;
  category: AtlasDomainFilter;
  edgeKinds: AtlasEdgeKind[];
}

export interface AtlasDomainInspectorViewModel extends AtlasDomainMapNode {
  name: string;
  health: string;
  plainSummary: string;
  startHereFiles: AtlasDomainFile[];
  incomingDomains: AtlasDomainRelationship[];
  outgoingDomains: AtlasDomainRelationship[];
}
```

- [ ] **Step 4: Replace `buildDomainInspector` with relationship-aware implementation**

Replace the existing `buildDomainInspector` function with:

```ts
export function buildDomainInspector(
  atlas: Pick<ProjectAtlas, 'nodes' | 'edges' | 'domains'>,
  domainId: string | null,
): AtlasDomainInspectorViewModel | null {
  if (!domainId) return null;
  const view = buildDomainMapViewModel(atlas);
  const node = view.nodes.find((candidate) => candidate.id === domainId);
  if (!node) return null;
  const relationships = buildDomainRelationshipSummary(view.nodes, view.edges, domainId);

  return {
    ...node,
    name: node.title,
    health: deriveHealth(node),
    plainSummary: node.description,
    startHereFiles: rankStartHereFiles(node.files).slice(0, 5),
    incomingDomains: relationships.incoming,
    outgoingDomains: relationships.outgoing,
  };
}
```

- [ ] **Step 5: Add relationship and ranking helpers**

Add these helpers near the existing private helpers in `src/lib/projectAtlasViewModel.ts`, before `deriveHealth`:

```ts
function buildDomainRelationshipSummary(
  nodes: AtlasDomainMapNode[],
  edges: AtlasDomainMapEdge[],
  domainId: string,
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, AtlasDomainRelationship>();
  const outgoing = new Map<string, AtlasDomainRelationship>();

  for (const edge of edges) {
    if (edge.target === domainId) {
      addDomainRelationship(incoming, nodesById.get(edge.source), edge.kind);
    }
    if (edge.source === domainId) {
      addDomainRelationship(outgoing, nodesById.get(edge.target), edge.kind);
    }
  }

  return {
    incoming: sortDomainRelationships(Array.from(incoming.values())),
    outgoing: sortDomainRelationships(Array.from(outgoing.values())),
  };
}

function addDomainRelationship(
  relationships: Map<string, AtlasDomainRelationship>,
  node: AtlasDomainMapNode | undefined,
  kind: AtlasEdgeKind,
) {
  if (!node) return;
  const existing = relationships.get(node.id);
  if (existing) {
    existing.edgeKinds = Array.from(new Set([...existing.edgeKinds, kind])).sort();
    return;
  }
  relationships.set(node.id, {
    id: node.id,
    name: node.title,
    category: node.category,
    edgeKinds: [kind],
  });
}

function sortDomainRelationships(relationships: AtlasDomainRelationship[]) {
  return relationships.sort((left, right) => left.name.localeCompare(right.name));
}

function rankStartHereFiles(files: AtlasDomainFile[]) {
  return [...files].sort((left, right) => {
    const scoreDelta = startHereScore(right) - startHereScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });
}

function startHereScore(file: AtlasDomainFile) {
  const path = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  let score = 0;

  if (/(^|\/)readme\.md$/.test(path)) score += 100;
  if (/\b(docs?|guide|overview|architecture)\b/.test(path)) score += 80;
  if (/\b(app|index|main)\.(tsx?|jsx?)$/.test(name)) score += 70;
  if (/\b(page|screen|view|component)\b/.test(path)) score += 60;
  if (/\b(viewmodel|usecase|service|repository)\b/.test(path)) score += 55;
  if (/\b(route|api|controller)\b/.test(path)) score += 45;
  if (/\b(schema|migration|config|settings)\b/.test(path)) score += 35;
  if (file.kind === 'component') score += 20;
  if (file.kind === 'route') score += 18;
  if (file.kind === 'database') score += 15;
  if (file.kind === 'test') score -= 20;

  return score;
}
```

- [ ] **Step 6: Run focused tests**

Run:

```bash
npx tsx tests/server/projectAtlasViewModel.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```bash
git add src/lib/projectAtlasViewModel.ts tests/server/projectAtlasViewModel.test.ts
git commit -m "feat: derive atlas reading context"
```

## Task 2: Reader-First Inspector UI

**Files:**
- Modify: `src/components/projectAtlas/AtlasNodeInspector.tsx`

- [ ] **Step 1: Replace the technical-first Info tab with reader-first sections**

In `src/components/projectAtlas/AtlasNodeInspector.tsx`, replace the `InfoTab` function with:

```tsx
function InfoTab({ inspector, copied, onCopyContext }: { inspector: AtlasDomainInspectorViewModel; copied: boolean; onCopyContext: () => void }) {
  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 dark:border-[#584a3b] dark:bg-[#1e1914]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">What this is</p>
            <h2 className="mt-2 break-words text-base font-black text-[#3f342b] dark:text-[#f8ead3]">{inspector.name}</h2>
            <p className="mt-1 text-[10px] font-black uppercase text-[#9a5b13] dark:text-[#d6b56d]">{inspector.category} · {inspector.status}</p>
          </div>
          <span className="rounded-md border border-[#e0c7a8] bg-[#fffdfa] px-2 py-1 text-[9px] font-black uppercase text-[#7b6554] dark:border-[#6d5642] dark:bg-[#241c15] dark:text-[#d8c5aa]">{inspector.health}</span>
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-[#5c493c] dark:text-[#f3eadf]">{inspector.plainSummary}</p>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {inspector.tags.map((tag) => (
            <span key={tag} className="rounded border border-[#e0c7a8] bg-[#fffdfa] px-2 py-1 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[#6d5642] dark:bg-[#241c15] dark:text-[#d6b56d]">{tag}</span>
          ))}
        </div>
      </section>

      <section className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 dark:border-[#584a3b] dark:bg-[#1e1914]">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">Start here</p>
        <div className="mt-3 space-y-2">
          {inspector.startHereFiles.length > 0 ? inspector.startHereFiles.map((file, index) => (
            <FileRow key={file.id} file={file} prefix={String(index + 1)} />
          )) : <EmptyInspectorText>No recommended entry files for this domain yet.</EmptyInspectorText>}
        </div>
      </section>

      <section className="grid gap-2">
        <RelationshipSection title="Depends on" emptyText="No outgoing domain dependencies in the current Atlas snapshot." relationships={inspector.outgoingDomains} />
        <RelationshipSection title="Used by" emptyText="No incoming domain dependents in the current Atlas snapshot." relationships={inspector.incomingDomains} />
      </section>

      <section className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 dark:border-[#584a3b] dark:bg-[#1e1914]">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">Technical details</p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Metric label="Files" value={inspector.metrics.files} />
          <Metric label="Nodes" value={inspector.metrics.nodes} />
          <Metric label="Dependencies" value={inspector.metrics.dependencies} />
          <Metric label="Types" value={inspector.metrics.types} />
        </div>
        <div className="mt-3 space-y-2">
          {Object.entries(inspector.fileTypeCounts).length > 0 ? Object.entries(inspector.fileTypeCounts).map(([type, count]) => (
            <div key={type} className="flex items-center justify-between rounded-md bg-[#fffdfa] px-3 py-2 text-[11px] font-bold text-[#3f342b] dark:bg-[#241c15] dark:text-[#f8ead3]">
              <span>.{type}</span>
              <span className="text-[#9a5b13] dark:text-[#d6b56d]">{count}</span>
            </div>
          )) : <EmptyInspectorText>No file type data.</EmptyInspectorText>}
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-[#7b6554] dark:text-[#d8c5aa]">{inspector.technologies.length ? inspector.technologies.join(', ') : 'Technologies unknown.'}</p>
      </section>

      <button type="button" onClick={onCopyContext} className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-[#e0c7a8] bg-[#fffdfa] px-3 py-2 text-[11px] font-extrabold text-[#5c493c] hover:border-[#c9872c] hover:bg-[#fff1d7] dark:border-[#6d5642] dark:bg-[#241c15] dark:text-[#f3eadf] dark:hover:bg-[#3a2f26]">
        <Clipboard size={14} /> {copied ? 'Copied Context' : 'Copy Context'}
      </button>
    </div>
  );
}
```

- [ ] **Step 2: Add shared row and relationship helpers**

Add these functions below `FilesTab`:

```tsx
function RelationshipSection({ title, relationships, emptyText }: { title: string; relationships: AtlasDomainInspectorViewModel['incomingDomains']; emptyText: string }) {
  return (
    <section className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 dark:border-[#584a3b] dark:bg-[#1e1914]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">{title}</p>
      <div className="mt-3 space-y-2">
        {relationships.length > 0 ? relationships.map((relationship) => (
          <div key={relationship.id} className="rounded-md border border-[#e0c7a8] bg-[#fffdfa] px-3 py-2 dark:border-[#6d5642] dark:bg-[#241c15]">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-black text-[#3f342b] dark:text-[#f8ead3]">{relationship.name}</span>
              <span className="rounded border border-[#e0c7a8] px-1.5 py-0.5 text-[8px] font-black uppercase text-[#9a5b13] dark:border-[#6d5642] dark:text-[#d6b56d]">{relationship.category}</span>
            </div>
            <p className="mt-1 truncate text-[9px] font-bold text-[#7b6554] dark:text-[#b89b82]">{relationship.edgeKinds.join(', ')}</p>
          </div>
        )) : <EmptyInspectorText>{emptyText}</EmptyInspectorText>}
      </div>
    </section>
  );
}

function FileRow({ file, prefix }: { file: AtlasDomainInspectorViewModel['files'][number]; prefix?: string }) {
  return (
    <div className="flex w-full items-start gap-3 rounded-md border border-[#e5d4bb] bg-[#fffdfa] p-3 text-left dark:border-[#584a3b] dark:bg-[#241c15]">
      <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-[#e0c7a8] bg-[#fff7eb] text-[10px] font-black text-[#9a5b13] dark:border-[#6d5642] dark:bg-[#1e1914] dark:text-[#d6b56d]">
        {prefix ?? <FileCode2 size={15} />}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12px] font-black text-[#3f342b] dark:text-[#f8ead3]">{file.name}</span>
        <span className="mt-1 block break-all text-[10px] font-mono leading-4 text-[#7b6554] dark:text-[#d8c5aa]">{file.path}</span>
        <span className="mt-2 inline-flex items-center gap-1 rounded border border-[#e0c7a8] bg-[#fff7eb] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[#6d5642] dark:bg-[#1e1914] dark:text-[#d6b56d]">
          <Link2 size={10} /> {file.type}
        </span>
      </span>
    </div>
  );
}

function EmptyInspectorText({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-[#e0c7a8] bg-[#fffdfa] px-3 py-2 text-[11px] leading-relaxed text-[#7b6554] dark:border-[#6d5642] dark:bg-[#241c15] dark:text-[#d8c5aa]">{children}</p>;
}
```

- [ ] **Step 3: Simplify `FilesTab` to use `FileRow`**

Replace the mapped file row in `FilesTab` with:

```tsx
{inspector.files.length > 0 ? inspector.files.map((file) => (
  <FileRow key={file.id} file={file} />
)) : (
  <div className="rounded-lg border border-[#e5d4bb] bg-[#fff7eb] p-4 text-[11px] text-[#7b6554] dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#d8c5aa]">
    No files are attached to this domain in the current Atlas snapshot.
  </div>
)}
```

- [ ] **Step 4: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/components/projectAtlas/AtlasNodeInspector.tsx
git commit -m "ui: make atlas inspector reader first"
```

## Task 3: Focus Map Copy And Emphasis

**Files:**
- Modify: `src/components/projectAtlas/AtlasGraph.tsx`

- [ ] **Step 1: Rename selected focus copy**

In the bottom-left status chip, replace:

```tsx
{nodes.length} domains · {edges.length} dependencies · {focusSelection ? 'focused dependencies' : denseGraph ? 'select a domain to show dependencies' : `${Math.round(viewport.zoom * 100)}%`}
```

with:

```tsx
{nodes.length} domains · {edges.length} dependencies · {focusSelection ? 'reading selected domain' : denseGraph ? 'select a domain to read its dependencies' : `${Math.round(viewport.zoom * 100)}%`}
```

- [ ] **Step 2: Increase unrelated-node dimming in focus mode**

In the `foreignObject` for nodes, replace:

```tsx
opacity={dimmed ? 0.18 : 1}
```

with:

```tsx
opacity={dimmed ? 0.1 : 1}
```

- [ ] **Step 3: Make focused edges easier to see**

In the edge render block, replace:

```ts
const edgeOpacity = dimmed ? 0.04 : focusSelection ? 0.72 : 0.18;
```

with:

```ts
const edgeOpacity = dimmed ? 0.03 : focusSelection && directlyRelated ? 0.9 : 0.14;
```

- [ ] **Step 4: Rename focused edge legend title**

In `EdgeLegend`, replace:

```tsx
<p className="text-[9px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">Focused edges</p>
```

with:

```tsx
<p className="text-[9px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">Reading path</p>
```

- [ ] **Step 5: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/components/projectAtlas/AtlasGraph.tsx
git commit -m "ui: clarify atlas focus mode"
```

## Task 4: Final Verification

**Files:**
- Verify modified files only.

- [ ] **Step 1: Run focused view-model tests**

Run:

```bash
npx tsx tests/server/projectAtlasViewModel.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Run build**

Run:

```bash
npm run build
```

Expected: PASS.

- [ ] **Step 4: Start local app for visual verification**

Run:

```bash
npm run dev
```

Expected: server starts and prints a local URL.

- [ ] **Step 5: Verify Project Atlas manually**

Open the local app, navigate to Project Atlas, select a domain, and confirm:

- Selected domain and related domains stay readable.
- Unrelated domains fade strongly.
- Bottom-left status says `reading selected domain`.
- Inspector starts with `What this is`.
- Inspector includes `Start here`, `Depends on`, `Used by`, and `Technical details`.
- Empty sections show plain empty-state text instead of fabricated graph knowledge.

- [ ] **Step 6: Record final status**

Do not commit generated build output. If any local dev server is still running after verification, stop it before final response.

## Self-Review

- Spec coverage: Task 1 covers deterministic reading-path, relationships, and empty state data. Task 2 covers reader-first inspector order. Task 3 covers focused map readability. Task 4 covers automated and manual verification.
- Placeholder scan: no TBD/TODO placeholders are present. Empty-state placeholder wording is not used in implementation steps.
- Type consistency: `AtlasDomainRelationship`, `plainSummary`, `startHereFiles`, `incomingDomains`, and `outgoingDomains` are defined before UI tasks use them.
