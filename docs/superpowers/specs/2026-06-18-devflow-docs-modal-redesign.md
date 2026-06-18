# Developer Documentation Hub Redesign

## 1. Goal
Overhaul the `JsonTemplateModal.tsx` to use a modern, premium "Sidebar Navigation" layout instead of a simple top-tab layout. This will improve readability, reduce cognitive load, and give the application a more polished, high-end aesthetic matching modern API documentation sites.

## 2. Architecture & Layout

**Current State**: 
Single column layout with two top tabs. Clicking a tab reveals a very long, scrolling list of all API endpoints or the full schema documentation.

**Proposed State (Option A)**:
- **Two-Pane Layout**:
  - **Left Sidebar (25-30% width)**: Sticky navigation menu grouping items logically.
    - Group 1: `Schema` -> `Import Template`
    - Group 2: `REST API` -> `GET /api/projects`, `POST /api/projects`, `POST /api/tasks`, etc.
  - **Right Content Area (70-75% width)**: Displays only the specific content for the currently selected item.

## 3. Aesthetics & UI Details

- **Premium Materials**: Implement glassmorphism using Tailwind's `backdrop-blur-md` combined with semi-transparent background colors (e.g., `bg-white/70 dark:bg-black/60`) for the modal overlay and panes.
- **Accents**: Subtle glowing borders and neon gradients to highlight the active sidebar item.
- **Micro-animations**:
  - Hover effects on sidebar items with a slight X-axis translation (`group-hover:translate-x-1`).
  - Fade-in and slight slide-up animation when the right content area changes (`animate-in fade-in slide-in-from-bottom-2 duration-300`).
- **Typography**: Clean, hierarchical sans-serif scaling. Method badges (GET, POST, PUT, DELETE) will use distinct, premium pill designs with rich colors.

## 4. Technical Implementation Strategy

- **State Management**: Replace `activeTab` with `selectedItemId: string`.
- **Component Refactoring**: 
  - Break down the massive `JsonTemplateModal.tsx` render function into smaller sub-components (if possible within the same file to keep scope tight, or extract if necessary, but preferred inline for simplicity).
  - Map `apiSpecs` to generate both the sidebar navigation list and the rendering logic for the right panel.
- **Data Structure**: Add an `id` field to `apiSpecs` items to use as keys for navigation selection.

## 5. Scope & Out of Scope
- **In Scope**: Rewriting the UI layer of `JsonTemplateModal.tsx`. Updating Tailwind classes for a premium look.
- **Out of Scope**: Changing the actual text/content of the documentation (already overhauled in DVF-0223). Creating new React components outside of this modal's context unless strictly necessary.
