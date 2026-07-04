# Understand Anything Atlas Theme Design

## Goal

Restyle DevFlow Project Atlas to follow the visual language of `Egonex-AI/Understand-Anything` while preserving DevFlow's existing light and dark theme behavior.

## Approved Direction

Use the Understand Anything dashboard design as the reference:

- Dark-mode first visual language: black canvas, glass panels, warm gold accents, subtle dotted/noise texture.
- Light mode adapted to DevFlow: warm paper background, dark readable text, same layout and hierarchy without forcing the app into dark mode.
- Serif display heading for the Atlas title.
- Header layout with an app title, compact mode chips, layer/filter chips, and action buttons.
- Search as its own full-width row under the header.
- Graph cards as dark or light elevated nodes with a colored left bar, compact type label, summary, and complexity/status label.
- Right inspector as a stronger side panel with stats and reader-first sections.
- Edges remain progressive: no full graph edge dump; only focused paths are visible.

## Scope

In scope:

- `ProjectAtlasPage.tsx` header/search/action layout and theme classes.
- `AtlasGraph.tsx` canvas, nodes, controls, status chip, and legend styling.
- `AtlasNodeInspector.tsx` panel and section styling.
- `AtlasSearchBar.tsx` full-row search styling.
- Minimal CSS theme support if needed.

Out of scope:

- Replacing the graph engine.
- Adding new graph data.
- Implementing full Understand Anything features such as real guided tours, semantic search, persona selector, or React Flow.
- Changing non-Atlas DevFlow screens.

## Success Criteria

- In dark mode, Project Atlas clearly resembles the Understand Anything dashboard.
- In light mode, the same layout remains readable and consistent with DevFlow's warm theme.
- The graph remains easier to read than before: focused paths only, unrelated nodes dimmed, readable inspector.
- Existing Atlas behavior continues to work.
