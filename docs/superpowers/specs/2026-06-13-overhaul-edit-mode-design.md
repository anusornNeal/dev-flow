# Task Details Edit Mode Overhaul Design

## 1. Goal Description
The objective is to overhaul the "Edit Mode" of the `TaskDetailsDrawer.tsx` component so that it matches the grouped, clean layout of the "Preview Mode". Currently, the Edit Mode is a single long vertical list of form inputs which looks cluttered and overwhelming. The new design groups related inputs into the same logical sections (Accordions and Panels) used in the Preview Mode.

## 2. Proposed Changes

### Core Task Header
- The inputs for **Issue Title**, **Lane Status**, **Urgency Level**, and **Checkout Branch** will remain at the top.
- We will streamline their styling to be less "boxy" and more integrated with the background.

### Agent Configuration Panel
- **Assigned Agent**, **AI Model Spec**, and **Effort Allocation** selects will be grouped horizontally in a single distinct panel, mirroring the "Agent Strip" pill seen in Preview Mode.

### Primary Work Details
- **Target Files to Modify** and **Implementation Checklist Steps** textareas will be styled with headers matching the Preview Mode (including icons like `FileCode` and `CheckSquare`).

### Detailed Specifications
- The **Detailed Specifications & Code (Markdown)** textarea will be placed between the Primary Work Details and the Accordions.

### Secondary Fields (Accordions)
We will introduce Accordions in Edit Mode, identically structured to those in Preview Mode, to house the remaining secondary fields:
1. **Links & References Accordion**: Contains the Design Image Upload button/preview and the Specification Link/URL input.
2. **QA Context Accordion**: Contains the Acceptance Criteria and Verification Steps textareas.
3. **Dev Context Accordion**: Contains the Reasoning, Repository Context, Jira Issue Key, Repository URL, and Source URL inputs.

## 3. Architecture & Components
- We will modify `src/components/TaskDetailsDrawer.tsx`.
- The state variables (`editedTitle`, `editedStatus`, etc.) will remain exactly the same.
- We will reuse the `openSections` state (or introduce a new `editOpenSections` if we want them distinct) to toggle the Accordions in Edit Mode.
- We will reuse the Accordion UI patterns (the `ChevronDown` button, the icon wrappers) from the Preview Mode block for the Edit Mode block.

## 4. Verification Plan
- Launch the application and open the `TaskDetailsDrawer`.
- Toggle to "Edit Spec".
- Verify that the inputs are now neatly grouped into Accordions.
- Verify that expanding/collapsing Accordions works correctly.
- Ensure that typing in the grouped inputs still updates the corresponding state variables and saves correctly.
