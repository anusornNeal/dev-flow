# Understand Anything Atlas Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle Project Atlas to match the Understand Anything dashboard while preserving DevFlow light/dark modes.

**Architecture:** Keep changes inside Atlas UI components. Use existing Tailwind dark variants and DevFlow theme class; do not change backend contracts or graph data.

**Tech Stack:** React, TypeScript, Tailwind CSS, lucide-react, Node test via `npx tsx`.

---

## Files

- Modify `src/components/ProjectAtlasPage.tsx`: header, full-row search, action/filter chips, top-level theme.
- Modify `src/components/projectAtlas/AtlasSearchBar.tsx`: search bar sizing and dark/light glass style.
- Modify `src/components/projectAtlas/AtlasGraph.tsx`: canvas, node cards, controls, status, legend.
- Modify `src/components/projectAtlas/AtlasNodeInspector.tsx`: right panel, stats cards, section surfaces.
- Optionally modify `src/index.css`: serif font utility only if needed.

## Tasks

- [ ] Restyle Atlas shell/header to Understand Anything layout with light/dark variants.
- [ ] Restyle search row and chips.
- [ ] Restyle graph canvas, nodes, controls, status, and legend.
- [ ] Restyle inspector panel and reader sections.
- [ ] Verify with `npx tsx tests/components/projectAtlas/atlasGraphEdgeVisibility.test.ts`, `npm run typecheck`, `npm run build`, and visual screenshots in both light/dark modes.

## Notes

- Keep progressive edge disclosure from the previous commit.
- Do not add nonfunctional tabs or buttons that imply unavailable features.
- Light mode should remain warm and readable; dark mode should carry the Understand Anything look most strongly.
