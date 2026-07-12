# Atlas Focus-Only Edges Design

## Context

Project Atlas currently draws its own routed SVG edges with bus lanes, markers, labels, and a persistent legend. Even after limiting edge count, the map still reads as a graph first and a domain-reading tool second.

The Understand-Anything dashboard handles edges differently:

- It uses React Flow for canvas behavior and edge rendering.
- Node components expose handles, so edges attach predictably to node sides.
- Graph layout is handled by ELK or force layout before rendering.
- Edges are styled by type, but they become prominent only when a node is selected or focused.
- Cross-layer and cross-container relationships are aggregated, so many raw relationships collapse into one readable visual connection.

DevFlow should adopt the same reading principle without adding a large graph dependency in this pass.

## Goals

- Remove the current custom routed edge system from `AtlasGraph`.
- Make the default domain overview line-free.
- Show relationships only when the user hovers or selects a domain.
- Aggregate repeated domain relationships into simple visual connections.
- Keep edge explanation in the inspector and reading path, not crowded across the canvas.
- Preserve the current Atlas visual theme, search, filters, zoom, pan, and inspector behavior.

## Non-Goals

- Do not migrate Atlas to React Flow yet.
- Do not add ELK, Dagre, or force-layout dependencies.
- Do not change the scanner, cache format, domain inference, or export formats.
- Do not show all relationships at once.

## Design

### Edge Behavior

The canvas has two states:

1. Overview state:
   - No edge paths are rendered.
   - The status chip says the map is in focus-only mode.
   - Domain cards remain fully readable.

2. Focus state:
   - Triggered by hover or selected domain.
   - Only relationships directly connected to the focused domain render.
   - Non-related cards dim slightly, matching the existing selection behavior.
   - Edge labels stay out of the canvas unless a very small focused set makes them useful.

### Edge Shape

The old routed path system is removed:

- Remove bus lanes.
- Remove per-node edge ports.
- Remove route labels from the SVG.
- Remove arrow marker definitions.
- Remove the large edge legend.

The replacement draws a simple quadratic curve between the horizontal sides of two cards:

- Source and target attach to the nearest left or right side.
- The curve bends gently based on distance and stable edge id.
- The path is thin, low contrast by default, and stronger only for the focused relationship.
- Direction is communicated in the inspector reading path instead of arrowheads.

This keeps the map visually closer to Understand-Anything's "relationships appear when needed" behavior while staying inside the current lightweight SVG implementation.

### Aggregation

Domain relationships are already grouped in `buildDomainMapViewModel` by `(kind, sourceDomain, targetDomain)`. The new renderer should rely on those grouped edges and avoid expanding back into raw file-level relationships.

For focused display, the helper returns:

- `visibleEdges`: directly connected grouped relationships.
- `focusedEdgeCount`: total direct grouped relationships.
- `hiddenFocusedEdgeCount`: relationships hidden by the readability cap.
- `relationshipGroups`: display-ready rows for the inspector or status copy.

The default focused cap remains small enough to keep the map readable.

### Inspector Copy

The inspector remains the main place to explain relationships:

- "Depends on" and "Used by" keep showing connected domains and edge kinds.
- The graph bottom status can say `showing N focused relationships`.
- The edge legend is replaced with a compact note: `Focus a domain to reveal direct relationships`.

### Testing

Update the focused edge tests so they prove:

- No edges render in overview state.
- Focusing a domain returns only directly connected grouped edges.
- The cap hides overflow relationships.
- Relationship counts remain stable and deterministic.

Run:

- `npx tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts`
- `npm run typecheck`
- `npm run build`

Visual verification should open Atlas and confirm:

- Overview has no lines.
- Hover/select reveals only direct relationships.
- The map remains readable in dark mode and light mode.
