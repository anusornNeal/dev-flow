# DevFlow Authoring Evidence Specialist

## Purpose
Load only when card authoring depends on Jira, Figma, Project Atlas, or another source that needs special evidence handling.

## Jira evidence
Use `get_jira_authoring_bundle` first for Jira-originated work. It should provide the issue, comments/attachments metadata, related keys, local duplicate hints, and recommended next reads in one bounded packet.

Do not start with repeated individual Jira calls when the bundle can answer the question. Read individual Jira evidence only when the bundle identifies missing material evidence.

Treat Jira as requirement/source evidence, not implementation truth. Inspect the current repository before naming implementation files or symbols. If an existing DevFlow card represents the same root work, update/merge it rather than creating a duplicate.

## Figma evidence
For a frontend card with a Figma source, preserve exact file/node provenance and node-specific implementation evidence.

Use the smallest sequence that proves the design:
- file metadata only when needed to establish source identity;
- exact node/design spec for the relevant node;
- avoid fetching unrelated frames or whole design trees.

Use `get_figma_design_spec` for normalized layout, typography, spacing, colors, constraints, and referenced assets. Summarize implementation-relevant evidence in `repoContext`; attach the source reference when the card needs persistent provenance.

Figma evidence rule: do not convert visual guesses into exact dimensions/copy when the source can provide them, and do not make Figma mandatory for frontend work that has no Figma source.

## Project Atlas
Use `get_project_atlas` as a companion, not a replacement for current repository evidence. It is appropriate for architecture, module boundaries, cross-module impact, onboarding/read order, or uncertain target files.

Prefer task-focused/diff-impact context when applicable. Verified Atlas facts may guide likely files and dependencies, but current repo evidence wins if the Atlas is stale or conflicts with code; do not override them silently.

Do not create every-file graph nodes or load the full Atlas for a simple clearly targeted card.

## Evidence priority
Latest explicit user clarification > current repository behavior > current source evidence (Jira/Figma) > stale summaries/inferred Atlas context. Record conflicts that materially affect implementation rather than blending incompatible assumptions.
