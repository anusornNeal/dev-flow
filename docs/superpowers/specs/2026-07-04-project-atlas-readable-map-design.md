# Project Atlas Readable Map Design

## Goal

Redesign the Project Atlas experience so a developer can understand the project map quickly, using the visual feel of `https://understand-anything.com/demo/` as a reference while improving readability over the current Atlas screen.

The page should help readers answer three questions without studying the whole graph:

1. What is this domain?
2. What does it depend on, and what depends on it?
3. Which files should I read first?

## Current State

Project Atlas already has a domain map, dependency edges, search, filters, a legend, zoom controls, and an inspector. The current screen is visually close to the reference, but it still asks the user to interpret too much at once:

- Dense maps show many faded cards and edge paths before the user knows where to look.
- The inspector leads with metrics, file types, and technologies instead of a plain-language reading path.
- Relationship direction is technically present, but not explained in a way that helps someone decide what to read next.
- Key files are mixed into the full file list, so the first useful entry point is not obvious.

## Recommended Approach

Use a focused reading mode:

- Keep the reference-style visual map as the primary surface.
- When no domain is selected, show a calm overview with minimal edge noise and an instruction-like status line.
- When a domain is selected, make that domain and its immediate neighbors visually dominant.
- Move human-readable understanding into the inspector before metrics.

This combines the best parts of the reference map with a practical developer reading flow.

## Alternatives Considered

### Visual Polish Only

This would tune colors, spacing, cards, and legends while keeping the current information order. It is lower risk, but it would mostly make the page prettier rather than easier to understand.

### Full Guided Reading Mode

This would add a dedicated step-by-step onboarding path across domains. It could be powerful, but it needs richer graph semantics and is larger than the current goal.

### Focus + Human Summary

This is the chosen approach. It improves the current screen directly, stays within the existing Project Atlas architecture, and targets the user's readability goal.

## User Experience Design

### Map Overview

The graph remains a full-screen canvas with domain cards, dotted warm background, pan, zoom, fit, and reset controls.

In overview mode:

- Cards are arranged with stable spacing and consistent sizes.
- Edges are either hidden or rendered at low emphasis when the graph is dense.
- The legend is compact and positioned so it does not compete with the selected content.
- The status chip tells the user to select a domain to inspect dependencies.

### Focus Mode

When a user selects a domain:

- The selected card becomes the visual anchor.
- Directly related domains stay readable.
- Unrelated domains fade strongly.
- Incoming and outgoing edges connected to the selected domain become clear.
- Edge direction remains arrow-to-target.
- The focused edge list uses readable source and target names.

The interaction should make it obvious which domains are upstream inputs and downstream consumers.

### Inspector Reading Order

The inspector changes from technical-first to reader-first.

The default selected-domain view should show:

1. **What This Is**: domain name, category, status, and plain-language description.
2. **Start Here**: 3-5 recommended files or nodes to read first.
3. **Depends On**: domains this domain points to.
4. **Used By**: domains that point to this domain.
5. **Key Files**: a concise list before the full file tab.
6. **Technical Details**: metrics, file types, and technologies.

Metrics stay available, but they no longer lead the experience.

## Data And View Model

Keep the existing `buildDomainMapViewModel` and `buildDomainInspector` flow. Extend the inspector view model with derived, UI-ready fields:

- `startHereFiles`: important files chosen from domain files.
- `incomingDomains`: readable related domains where another domain depends on the selected domain.
- `outgoingDomains`: readable related domains the selected domain depends on.
- `plainSummary`: a human-readable summary derived from existing domain summary or file/node signals.

Selection of start-here files should be deterministic and local:

- Prefer README, docs, route, component, ViewModel, use case, service, repository, schema, and config entry points.
- Limit to a small number so the user is not overwhelmed.
- Fall back to the first sorted files when no stronger signal exists.

No backend contract change is required for the first implementation.

## Component Boundaries

Keep changes focused in the current Project Atlas area:

- `src/lib/projectAtlasViewModel.ts`: derive relationship and reading-path fields.
- `src/components/projectAtlas/AtlasNodeInspector.tsx`: render reader-first sections.
- `src/components/projectAtlas/AtlasGraph.tsx`: tune focus-mode emphasis, status text, and legend behavior if needed.
- `src/components/ProjectAtlasPage.tsx`: pass selected state through existing props; avoid new global state.

Avoid unrelated refactors and keep each component's responsibility narrow.

## Error And Empty States

Existing loading, empty, and error states remain.

If a selected domain has no files or relationships:

- Show a plain empty message in the relevant section.
- Keep the summary and metrics visible.
- Do not show placeholder content that looks like real graph knowledge.

## Testing And Verification

Add focused unit coverage for the view-model derivations:

- Start-here file ranking is deterministic.
- Incoming and outgoing domains are separated correctly.
- Domains with no files or relationships still produce a valid inspector model.

Run at minimum:

```bash
npm run typecheck
tsx tests/lib/projectAtlasViewModel.test.ts
```

For UI verification:

- Start the app locally.
- Open Project Atlas.
- Select a domain.
- Confirm unrelated domains dim, related edges are readable, and inspector starts with human-readable sections.
- Capture at least one desktop screenshot as visual evidence.

## Out Of Scope

- Changing the Atlas scan backend.
- Adding AI-generated explanations.
- Building a full tutorial or multi-step guided walkthrough.
- Replacing the existing SVG graph engine with a new library.
- Changing unrelated board, drawer, or task workflows.

## Success Criteria

The redesign is successful when a reader can select a domain and quickly understand:

- What the domain is for.
- What it depends on.
- What depends on it.
- Which files to read first.

The screen should still feel like the reference map, but the information order must make the project easier to understand than the current implementation.
