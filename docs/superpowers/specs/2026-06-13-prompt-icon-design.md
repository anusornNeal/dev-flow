# Prompt Template Icon Redesign

## Goal
Make the "Copy Prompt Template" button more communicative by changing its icon from a generic `Copy` to `MessageSquareTerminal`, which better represents "an AI instruction prompt."

## Selected Design
**MessageSquareTerminal Icon**
We will replace the `lucide-react` `Copy` icon with `MessageSquareTerminal` in `src/components/CopyTemplateButton.tsx`.

## Implementation
1. In `src/components/CopyTemplateButton.tsx`, update the import to include `MessageSquareTerminal`.
2. In the render function (around line 60), change `<Copy size={12} />` to `<MessageSquareTerminal size={12} />`.
3. The successful copied state (`CheckCircle2`) and error state (`AlertCircle`) will remain unchanged.
