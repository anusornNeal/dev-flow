# Task Card Category Badge Design

The current task cards use a thin vertical color bar on the left edge to indicate whether a task is "frontend" or "backend". This is subtle and can be hard to notice when scanning a large board. 

## Proposed Changes

We will transition from the left-edge color bar to clear, explicit badges placed in the header of the task card.

1.  **Remove Old Indicator:**
    *   Remove the `<span className="w-1 h-16 absolute left-0...">` that renders the vertical color bar in `TaskCard.tsx`.

2.  **Add New Category Badges:**
    *   Introduce a small badge (pill-shaped) next to the Task ID.
    *   **Frontend Badge:** 
        *   Background: Soft blue (`bg-[#e0f0f5]` / dark: `bg-[#2a4552]`)
        *   Text Color: Dark blue (`text-[#2b5a6e]` / dark: `text-[#82b8cf]`)
        *   Icon: `Layout` or `Monitor` from `lucide-react`.
        *   Text: "Frontend"
    *   **Backend Badge:**
        *   Background: Soft brown/gray (`bg-[#f0e6e0]` / dark: `bg-[#3d322c]`)
        *   Text Color: Dark brown (`text-[#6e5343]` / dark: `text-[#cfb099]`)
        *   Icon: `Server` from `lucide-react`.
        *   Text: "Backend"
    *   General tasks will not have a badge (maintaining current behavior).

3.  **Layout adjustments:**
    *   The badge will be placed in the same flex row as the Task ID and the In-Progress indicator, ensuring it doesn't take up extra vertical space.
