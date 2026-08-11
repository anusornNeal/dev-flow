# DevFlow Authoring Evidence Specialist

## Purpose
Load this skill only when authoring depends on Jira, Figma, Project Atlas, or another source that needs provenance and authority rules. It separates desired requirements from evidence about the implementation that exists today.

## Jira evidence
Use `get_jira_authoring_bundle` first for Jira-originated work. It provides a bounded packet of issue text, comments, attachment metadata, related keys, local duplicate hints, and recommended next reads.

Do not fan out into repeated source calls when the bundle already answers the requirement. Read additional Jira material only when the bundle identifies material missing evidence.

Jira is requirement provenance, not repository implementation truth. Inspect current code before naming files, symbols, or current behavior.

## Figma evidence
For frontend work with an approved Figma source, preserve exact file/node provenance.

Use `get_figma_authoring_context` for the exact relevant node set so normalized design evidence and source references arrive together. Use `attach_figma_context_to_task` when the owning card should persist those exact refs. Keep reads bounded to the nodes that affect the card.

Do not turn visual guesses into exact copy, spacing, dimensions, or assets when the approved design source can provide them. Do not make Figma mandatory when the requirement has no Figma source.

## Project Atlas
Use `get_project_atlas` as repository-navigation and architecture evidence for uncertain targets, module boundaries, cross-module impact, onboarding, or read order.

Atlas does not replace current file inspection. Treat stale or inferred Atlas context as navigation hints and verify implementation claims against current repository evidence before writing the implementation map.

## Desired requirement authority
Desired behavior is established by requirement sources, not by whatever the current code happens to do. Resolve conflicts in this order when applicable:
1. Latest explicit user or product-owner clarification.
2. Current approved DevFlow task/specification and approved Jira comments or requirement text.
3. Current approved Figma/design evidence for visual and interaction requirements.
4. Older requirement summaries or inferred interpretations.

When two current approved requirement sources genuinely conflict, record the conflict or obtain the missing product decision instead of silently blending them.

## Implementation evidence
Repository files, branch/diff state, tests, logs, and established project patterns describe what exists now, where the change belongs, and what regressions must be preserved. Atlas may supplement this implementation evidence when it is current and verified.

Repository evidence cannot override an approved requirement merely because current code behaves differently. A mismatch between current code and desired behavior is often the implementation delta the card exists to change.

Likewise, requirement documents should not invent current implementation facts. Confirm current behavior and implementation targets from repository evidence before putting them in `repoContext` or `targetFiles`.

## Conflict recording
Keep desired behavior and current implementation findings separately understandable. If a source is stale, inferred, inaccessible, or superseded, say so when that limitation changes scope or confidence. Remove superseded assumptions from the card instead of preserving contradictory guidance.
