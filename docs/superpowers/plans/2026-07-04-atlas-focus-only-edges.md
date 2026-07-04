# Atlas Focus-Only Edges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the old always-visible routed Atlas edge system with a focus-only relationship display based on the Understand-Anything edge-reading model.

**Architecture:** Keep the current lightweight SVG canvas and domain cards, but remove bus-lane routing, markers, route labels, and the large legend. `selectReadableAtlasEdges` remains the focused relationship selector, and `AtlasGraph` renders only direct focused relationships as simple side-to-side quadratic curves.

**Tech Stack:** React 19, TypeScript, SVG paths, Node `node:test`, Vite.

---

### Task 1: Update Focused Edge Selector Tests

**Files:**
- Modify: `tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts`
- Modify: `src/components/projectAtlas/AtlasGraph.tsx`

- [ ] **Step 1: Write the failing test**

Replace `tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  selectReadableAtlasEdges,
} = await import('../../../src/components/projectAtlas/AtlasGraph.js');

const edges: any[] = [
  { id: 'imports:domain:a->domain:b', source: 'domain:a', target: 'domain:b', kind: 'imports', label: 'Imports', sourceEdgeIds: ['raw:1', 'raw:2'] },
  { id: 'tests:domain:c->domain:a', source: 'domain:c', target: 'domain:a', kind: 'tests', label: 'Tests', sourceEdgeIds: ['raw:3'] },
  { id: 'related:domain:c->domain:d', source: 'domain:c', target: 'domain:d', kind: 'related', label: 'Related', sourceEdgeIds: ['raw:4'] },
  { id: 'exports:domain:a->domain:e', source: 'domain:a', target: 'domain:e', kind: 'exports', label: 'Exports', sourceEdgeIds: ['raw:5', 'raw:6', 'raw:7'] },
];

test('selectReadableAtlasEdges hides all visual edges until a domain is focused', () => {
  const readable = selectReadableAtlasEdges(edges, null, 2);

  assert.deepEqual(readable.visibleEdges, []);
  assert.deepEqual(readable.relationshipGroups, []);
  assert.equal(readable.hiddenFocusedEdgeCount, 0);
  assert.equal(readable.focusedEdgeCount, 0);
});

test('selectReadableAtlasEdges returns only direct grouped relationships for a focused domain', () => {
  const readable = selectReadableAtlasEdges(edges, 'domain:a', 4);

  assert.deepEqual(readable.visibleEdges.map((edge: any) => edge.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
    'tests:domain:c->domain:a',
  ]);
  assert.deepEqual(readable.relationshipGroups, [
    { id: 'exports:domain:a->domain:e', source: 'domain:a', target: 'domain:e', kind: 'exports', label: 'Exports', rawRelationshipCount: 3 },
    { id: 'imports:domain:a->domain:b', source: 'domain:a', target: 'domain:b', kind: 'imports', label: 'Imports', rawRelationshipCount: 2 },
    { id: 'tests:domain:c->domain:a', source: 'domain:c', target: 'domain:a', kind: 'tests', label: 'Tests', rawRelationshipCount: 1 },
  ]);
  assert.equal(readable.focusedEdgeCount, 3);
  assert.equal(readable.hiddenFocusedEdgeCount, 0);
});

test('selectReadableAtlasEdges caps focused visual clutter but keeps total counts', () => {
  const readable = selectReadableAtlasEdges(edges, 'domain:a', 2);

  assert.deepEqual(readable.visibleEdges.map((edge: any) => edge.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
  ]);
  assert.deepEqual(readable.relationshipGroups.map((group: any) => group.id), [
    'exports:domain:a->domain:e',
    'imports:domain:a->domain:b',
  ]);
  assert.equal(readable.focusedEdgeCount, 3);
  assert.equal(readable.hiddenFocusedEdgeCount, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts`

Expected: FAIL because `relationshipGroups` is not returned yet.

- [ ] **Step 3: Add relationshipGroups to selector**

In `src/components/projectAtlas/AtlasGraph.tsx`, update `selectReadableAtlasEdges` so the null branch includes `relationshipGroups: []`, and the focused branch maps visible edges:

```ts
return {
  visibleEdges,
  focusedEdgeCount: focused.length,
  hiddenFocusedEdgeCount: Math.max(0, focused.length - visibleEdges.length),
  relationshipGroups: visibleEdges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    label: edge.label,
    rawRelationshipCount: edge.sourceEdgeIds.length,
  })),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts src/components/projectAtlas/AtlasGraph.tsx
git commit -m "test: cover atlas focus only edges"
```

### Task 2: Remove Old Routed Edge System

**Files:**
- Modify: `src/components/projectAtlas/AtlasGraph.tsx`

- [ ] **Step 1: Remove old edge-only structures**

In `src/components/projectAtlas/AtlasGraph.tsx`, delete these declarations:

```ts
interface EdgeRoute {
  path: string;
  label: Point;
}

const GRID_ORIGIN_X = 70;
const GRID_ORIGIN_Y = 70;
const GRID_COLUMN_GAP = 360;
const GRID_ROW_GAP = 240;
const EDGE_PORT_GAP = 32;
const EDGE_ROUTE_RADIUS = 20;

const EDGE_LEGEND_ITEMS: EdgeVisualStyle[] = [
  EDGE_VISUAL_STYLES.direct,
  EDGE_VISUAL_STYLES.soft,
  EDGE_VISUAL_STYLES.reference,
  EDGE_VISUAL_STYLES.test,
];
```

Also remove `denseGraph` and `edgePorts` from the component.

- [ ] **Step 2: Remove marker defs and label rendering**

Delete the `<defs>` block that creates `atlas-arrow-*` markers.

In the edge render loop, remove:

```tsx
const showLabel = Boolean(!denseGraph && focusSelection && directlyRelated && viewport.zoom > 0.82 && edge.sourceEdgeIds.length <= 3);
markerEnd={focusSelection && directlyRelated ? `url(#atlas-arrow-${visualStyle.variant})` : undefined}
{showLabel && (
  <text x={route.label.x} y={route.label.y - 10} className="fill-[#8a4d0d] text-[10px] font-bold dark:fill-[#f7d28a]">
    {edge.label}
  </text>
)}
```

- [ ] **Step 3: Delete old route helpers**

Remove these functions from the bottom of `AtlasGraph.tsx`:

```ts
function buildEdgePorts(...)
function edgeRoute(...)
function gridPosition(...)
function edgeBusLaneY(...)
function roundedPath(...)
function moveToward(...)
function stableLaneOffset(...)
```

Keep `stableHash` because the new curve uses it.

- [ ] **Step 4: Run typecheck to expose missing references**

Run: `npm run typecheck`

Expected: FAIL if any removed routing symbol is still referenced.

### Task 3: Add Simple Focus-Only Curves and Compact Relationship Note

**Files:**
- Modify: `src/components/projectAtlas/AtlasGraph.tsx`

- [ ] **Step 1: Add simple edge curve helper**

Add this helper near `edgeVisualStyle`:

```ts
function simpleFocusedEdgePath(edge: AtlasDomainMapEdge, source: Point, target: Point) {
  const sourceCenter = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT / 2 };
  const targetCenter = { x: target.x + NODE_WIDTH / 2, y: target.y + NODE_HEIGHT / 2 };
  const sourceToRight = targetCenter.x >= sourceCenter.x;
  const start = {
    x: source.x + (sourceToRight ? NODE_WIDTH : 0),
    y: sourceCenter.y,
  };
  const end = {
    x: target.x + (sourceToRight ? 0 : NODE_WIDTH),
    y: targetCenter.y,
  };
  const distance = Math.max(80, Math.abs(end.x - start.x));
  const bend = ((stableHash(edge.id) % 5) - 2) * 10;
  const control = {
    x: start.x + (sourceToRight ? distance : -distance) * 0.5,
    y: (start.y + end.y) / 2 + bend,
  };
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}
```

- [ ] **Step 2: Render only focused curves**

In the edge render loop, replace old `route` logic with:

```tsx
const path = simpleFocusedEdgePath(edge, source, target);
const edgeOpacity = focusSelection && directlyRelated ? 0.82 : 0;
const edgeWidth = focusSelection && directlyRelated ? visualStyle.focusWidth : visualStyle.baseWidth;
return (
  <g key={edge.id} opacity={edgeOpacity} pointerEvents="none">
    <path
      d={path}
      fill="none"
      className="stroke-[#f8efe2] dark:stroke-[#0a0a0a]"
      strokeWidth={edgeWidth + 6}
      strokeLinecap="round"
    />
    <path
      d={path}
      fill="none"
      stroke={visualStyle.stroke}
      strokeWidth={edgeWidth}
      strokeDasharray={visualStyle.dashArray}
      strokeLinecap="round"
    />
  </g>
);
```

- [ ] **Step 3: Replace EdgeLegend with compact note**

Remove `EdgeLegend` and `LegendLine`.

Replace the component call:

```tsx
<EdgeLegend focusedEdges={focusedEdges} focusSelection={focusSelection} hiddenFocusedEdgeCount={readableEdges.hiddenFocusedEdgeCount} nodesById={nodesById} />
```

with:

```tsx
<RelationshipFocusNote
  relationshipGroups={readableEdges.relationshipGroups}
  focusSelection={focusSelection}
  hiddenFocusedEdgeCount={readableEdges.hiddenFocusedEdgeCount}
  nodesById={nodesById}
/>
```

Add this component:

```tsx
function RelationshipFocusNote({
  relationshipGroups,
  focusSelection,
  hiddenFocusedEdgeCount,
  nodesById,
}: {
  relationshipGroups: Array<{ id: string; source: string; target: string; kind: string; label: string; rawRelationshipCount: number }>;
  focusSelection: string | null;
  hiddenFocusedEdgeCount: number;
  nodesById: Map<string, AtlasDomainMapNode>;
}) {
  return (
    <div className="absolute bottom-4 right-4 w-72 rounded-lg border border-[#d8c3a6] bg-[#fffaf2]/95 p-3 text-[#5c493c] shadow-xl backdrop-blur dark:border-[rgba(212,165,116,0.18)] dark:bg-[#141414]/92 dark:text-[#f5f0eb]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d4a574]">Focus Relationships</p>
      {!focusSelection ? (
        <p className="mt-2 text-[10px] font-bold leading-relaxed text-[#7b6554] dark:text-[#a39787]">Focus a domain to reveal direct relationships. Overview stays line-free for readability.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {relationshipGroups.slice(0, 5).map((group) => {
            const source = nodesById.get(group.source)?.title ?? group.source;
            const target = nodesById.get(group.target)?.title ?? group.target;
            return (
              <div key={group.id} className="text-[9px] font-bold text-[#6d5a4d] dark:text-[#d8c5aa]">
                <p className="truncate"><span className="text-[#3f342b] dark:text-[#f8ead3]">{source}</span> -&gt; {target}</p>
                <p className="truncate text-[#8a6d55] dark:text-[#a39787]">{group.label} / {group.rawRelationshipCount} raw relationships</p>
              </div>
            );
          })}
          {hiddenFocusedEdgeCount > 0 && <p className="text-[9px] font-bold text-[#8a6d55] dark:text-[#b89b82]">+{hiddenFocusedEdgeCount} hidden to keep the map readable</p>}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Update status copy**

Change the bottom-left status line to:

```tsx
{nodes.length} domains / {edges.length} relationships / {focusSelection ? `showing ${focusedEdges.length} focused relationships` : 'focus-only edges'}
```

- [ ] **Step 5: Run focused test and typecheck**

Run:

```bash
npx tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts
npm run typecheck
```

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/projectAtlas/AtlasGraph.tsx
git commit -m "ui: replace atlas routed edges with focus only curves"
```

### Task 4: Final Verification

**Files:**
- Verify only unless small fixes are required.

- [ ] **Step 1: Run production build**

Run: `npm run build`

Expected: PASS.

- [ ] **Step 2: Visual check local Atlas**

Start local server:

```powershell
$out='C:\Users\tatar\Projects\dev-flow\logs\atlas-focus-edges.out.log'
$err='C:\Users\tatar\Projects\dev-flow\logs\atlas-focus-edges.err.log'
foreach ($log in @($out,$err)) { if (Test-Path $log) { Remove-Item -LiteralPath $log -Force } }
$args='/c set DEVFLOW_PORT=3100&& set PORT=3100&& npm run dev'
Start-Process -FilePath 'cmd.exe' -ArgumentList $args -WorkingDirectory 'C:\Users\tatar\Projects\dev-flow' -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden -PassThru
```

Open `http://localhost:3100/?projectId=project-1781141088281-533757#atlas` and confirm:

- Overview has no relationship lines.
- Hover/select a domain reveals only directly related curves.
- Compact relationship note replaces the old legend.
- Dark mode remains readable.
- Light mode styles remain valid.

- [ ] **Step 3: Stop local server and remove transient logs**

Find the PID on port 3100:

```powershell
netstat -ano | Select-String ':3100'
```

Stop only the PID that was started for this check, then remove:

```powershell
Remove-Item -LiteralPath logs\atlas-focus-edges.out.log -Force
Remove-Item -LiteralPath logs\atlas-focus-edges.err.log -Force
```

- [ ] **Step 4: Commit verification fixes if needed**

If verification required code changes:

```bash
git add src/components/projectAtlas/AtlasGraph.tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts
git commit -m "fix: polish atlas focus only edge display"
```
