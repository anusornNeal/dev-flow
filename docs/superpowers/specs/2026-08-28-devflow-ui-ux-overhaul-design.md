# DevFlow UI/UX Overhaul Design Contract

Date: 2026-08-28
Status: Foundation for DVF-0750 / DVF-0751

## Goal

Make DevFlow easier to scan, understand, and operate across every surface without changing task, project, agent, or runtime business behavior. The overhaul must converge on one visual and interaction language rather than redesigning each screen independently.

DVF-0751 owns the shared contract. DVF-0752 through DVF-0759 may adapt their surfaces to this contract, but should not invent competing foundational tokens, status semantics, control sizes, action hierarchy, or overflow rules. DVF-0760 is the final cross-app audit.

## Product direction

DevFlow is a dense developer operations tool. The interface should feel compact and capable, but not noisy. The default hierarchy is:

1. **What needs attention or what can I do next?**
2. **What is the current state and consequence?**
3. **What supporting metadata helps me decide?**
4. **What technical detail can I inspect if needed?**

Developer metadata remains available, but IDs, model names, internal codes, paths, timestamps, and secondary badges must not visually compete with the current task, primary action, blocker, or failure.

## Semantic token contract

`src/index.css` is the authoritative global token source. Use semantic names rather than copying literal light/dark colors into new shared UI.

### Color roles

- `--df-color-canvas`: app background.
- `--df-color-surface`: primary contained surface.
- `--df-color-surface-raised`: controls, popovers, and raised content.
- `--df-color-surface-muted`: headers, footers, selected/quiet grouping surfaces.
- `--df-color-surface-subtle`: low-emphasis hover/selection surface.
- `--df-color-text`, `--df-color-text-strong`: primary readable content.
- `--df-color-text-muted`, `--df-color-text-subtle`: supporting metadata only.
- `--df-color-border`, `--df-color-border-strong`: normal and emphasized boundaries.
- `--df-color-primary`: highest-priority normal action.
- `--df-color-accent`: selection, emphasis, and brand-adjacent attention. It is not an error color.
- `--df-color-success`, `warning`, `danger`, `info`: semantic states. State meaning must not rely on color alone.
- `--df-color-focus-ring`: keyboard focus indicator.

Every semantic role has a light and dark value. Later cards should prefer the semantic role even if the current literal color appears visually similar.

### Spacing and density

Use the shared 4/8/12/16/20/24/32 px rhythm. Do not introduce arbitrary spacing when an existing token is close enough.

Default control height is 40 px. Compact controls are 32 px and should be limited to dense secondary tooling. Large primary controls may use 44 px. A control must not become shorter simply because its label is short.

Default radii are 8 px, 12 px, and 16 px. Pill shapes are reserved for true pills/badges/toggles, not general rectangular controls.

## Typography and hierarchy

DevFlow keeps JetBrains Mono as the product UI typeface for now. Typography communicates importance through size, weight, spacing, and placement rather than adding more colors.

- Page/surface title: strongest local label; one per surface region.
- Section title: clearly stronger than body/metadata, but subordinate to page title.
- Body: readable explanatory or actionable content.
- Metadata: small and muted; never the only place to communicate a critical state.
- Internal codes: monospace metadata or technical disclosure, never the headline shown to a normal user.

Avoid all-uppercase paragraphs. Uppercase is acceptable for short metadata labels and compact badges only.

## Action hierarchy

Each decision area should normally expose one visually dominant action.

- **Primary:** advances the user's intended normal workflow.
- **Secondary:** safe alternative, cancel, dismiss, or supporting action.
- **Danger:** irreversible or materially destructive action. Use danger semantics only for destructive consequences.
- **Icon-only:** secondary by default; always needs an accessible label/tooltip where its meaning is not universally obvious.

Do not place two visually identical high-emphasis actions beside each other unless they truly have equal consequence and priority.

### Destructive safety

A destructive confirmation must:

- state the object/action being affected;
- state the irreversible or material consequence;
- visually distinguish the destructive action from Cancel;
- put initial keyboard focus on the safe action;
- allow Escape/backdrop dismissal while idle;
- prevent duplicate dismissal/confirmation while an explicitly tracked destructive operation is busy;
- never make the danger action look like a routine accent action.

`ConfirmModal` is currently used only for Delete Task and Delete Project, so its default variant is destructive. A future non-destructive confirmation must opt into the primary variant explicitly.

## Status and feedback contract

Status text exists to help the user decide what to do, not to mirror implementation state.

A useful status message should answer, in this order where applicable:

1. **State:** what is happening or what failed?
2. **Consequence:** what does that mean for the user's current action?
3. **Next action:** what can the user do now?
4. **Technical detail:** code, provider response, raw path, diagnostic payload, or implementation-specific context behind progressive disclosure.

Examples of good structure:

- `Connection lost. Live updates are paused; displayed data may be stale. Reconnect or refresh.`
- `Task move blocked. Resolve the active agent run before moving this card.`
- `Settings saved. Restart DevFlow for the new runtime credential to take effect.`

Avoid:

- showing both `Failed` and a second badge saying `Error` for the same event;
- surfacing raw server error text as the only explanation;
- showing a status indicator that has no consequence or action;
- making technical codes more prominent than the human-readable state;
- permanent success banners for routine actions when a brief confirmation is enough.

Shared feedback styles use `df-feedback` plus semantic modifiers. Surface-specific cards may choose inline feedback, banners, empty states, or dialogs based on consequence, but the message structure remains the same.

## Text overflow contract

Long content must never force the surrounding layout wider than its intended container.

### Titles and names

Task titles, project names, preview names, modal titles, and human-readable labels should wrap naturally when the space is meant for reading. In dense cards/lists they may clamp to 2-3 lines with the full value available in detail view or tooltip where appropriate.

### IDs and badges

Task IDs and short status/category badges stay on one line. If an unexpectedly long value enters a badge, truncate rather than expanding the parent. Critical semantic meaning must remain visible outside the truncated portion.

### Paths, branch names, URLs, model names, and technical identifiers

Use a constrained single-line truncate in dense rows. In detail/disclosure views use `overflow-wrap: anywhere` / `df-break-technical` so long unbroken values wrap instead of creating horizontal page overflow. Full technical values should remain copyable where the feature already supports copying.

### User/server messages

Human-readable messages wrap. Raw payloads and stack-like content belong in a technical disclosure or scrollable diagnostic region; do not let them define the normal surface width.

### Popovers and menus

Menus must be constrained to the viewport. Long option labels truncate inside the menu; the full string may be exposed through a title/accessible label. A menu must not use unbounded `w-max` without a viewport maximum.

## Shared control behavior

### CustomSelect

`CustomSelect` remains source-compatible for existing callers and gains a shared interaction contract:

- native button trigger;
- `aria-haspopup=listbox`, expanded state, and real `disabled` support;
- Arrow Down/Up opens and navigates;
- Home/End jump within the list;
- Enter/Space selects the highlighted option;
- Escape closes without selection;
- clicking outside closes;
- long labels remain constrained;
- selected and highlighted states are visually distinct and work in light/dark themes;
- focus remains visible from keyboard use.

Existing caller-specific outer styling is preserved during the migration. Later surface cards can remove one-off container literals incrementally rather than forcing DVF-0751 to rewrite every select caller.

### ConfirmModal

`ConfirmModal` owns the canonical shared destructive confirmation hierarchy and accessibility semantics:

- `role=dialog`, `aria-modal`, labelled title/message;
- safe Cancel receives initial focus;
- Escape/backdrop dismissal when idle;
- danger vs primary variant semantics;
- disabled/busy confirmation support;
- full-width stacked action order on narrow layouts, horizontal actions when space permits;
- long title/message wrapping;
- shared surface, border, focus, button, and dark-mode tokens.

## Focus, keyboard, and pointer behavior

All interactive controls must show a visible focus indicator for keyboard focus. Hover is supplementary feedback, never the only indication that an element is interactive.

Do not implement disabled controls solely with `pointer-events: none`; when a component owns the control, expose a real disabled state so keyboard and accessibility behavior match pointer behavior.

Icon-only controls require an accessible name. Dialogs and popovers must provide an Escape path when dismissal is safe.

## Light and dark modes

Light and dark modes use the same semantic hierarchy. Dark mode is not a second independent palette to design screen-by-screen.

A semantic state keeps the same meaning in both modes. Do not reuse danger red as a generic accent in one theme, or success green as decoration. Borders and muted text must remain distinguishable without overpowering content.

## Responsive and narrow-container rules

The overhaul targets desktop first but must tolerate narrow windows and resizable panels.

- Every flex/grid child that contains variable text should be able to shrink (`min-width: 0` where needed).
- Prefer wrapping action groups before allowing the entire page to overflow.
- Dialog actions stack on narrow widths with the safe action remaining easy to reach.
- Popovers are capped to the viewport.
- Dense metadata may collapse, clamp, or move behind disclosure before primary content/actions are removed.
- Horizontal scrolling is acceptable for intentionally horizontal structures such as the Kanban board, not for accidental text overflow inside cards or dialogs.

## Motion

Motion is functional first. Preserve lightweight existing product personality where it does not interfere with work, but respect `prefers-reduced-motion`. Do not add decorative continuous motion to operational status surfaces.

## Surface-card boundaries

The parallel overhaul cards should apply this foundation rather than redefine it:

- **DVF-0752:** app shell, header, sidebar, navigation, project switching.
- **DVF-0753:** board lanes and task cards.
- **DVF-0754:** Task Inspector and task detail information architecture.
- **DVF-0755:** Agent Office state/attention hierarchy.
- **DVF-0756:** UI Preview Library.
- **DVF-0757:** Settings and integrations.
- **DVF-0758:** task authoring, import, and move-blocker dialogs.
- **DVF-0759:** utility/developer modals and viewers.
- **DVF-0760:** final consistency, overflow, responsive, and accessibility audit.

If a child discovers a missing semantic role, it should extend the foundation deliberately instead of adding a screen-specific literal that duplicates an existing role.

## Non-goals for DVF-0751

- No task/project/agent lifecycle changes.
- No navigation restructure.
- No board/card information redesign.
- No Settings, Agent Office, Preview Library, or Task Inspector overhaul in this card.
- No wholesale replacement of all existing Tailwind literal colors in one pass; migration happens in the owned surface cards.
- No new animation system or third-party component library.

## Verification expectations

DVF-0751 should prove that the foundation itself is coherent and does not break existing behavior:

- shared components compile and focused component tests pass;
- `CustomSelect` exposes deterministic keyboard behavior and real disabled semantics;
- `ConfirmModal` exposes dialog semantics, safe destructive hierarchy, and busy/disabled behavior;
- long labels/messages are constrained by the shared rules;
- light/dark token pairs exist for shared semantic roles;
- the project typecheck/build-level verification selected by DevFlow passes on the final frozen candidate.
