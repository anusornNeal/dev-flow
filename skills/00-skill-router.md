# DevFlow Skill Router

## Purpose
Choose the smallest guidance set required for the current DevFlow action. Do not load every authoring skill by default.

## Common card authoring
For a normal non-Jira, non-Figma card with clear scope:
- load `01-authoring-core` only;
- call `get_repo_context_bundle` first when a project is known;
- use targeted reads only when the bundle is insufficient;
- use the live task/MCP schema for field types and enums;
- do not load `02-schema-reference` unless field placement is genuinely unclear.

A common authoring flow should normally fit in 2–4 meaningful calls: lean guidance, bounded repo evidence, then create/update (plus one focused read only if required).

## Source-specific evidence
Load `05-authoring-evidence` only when the card depends on Jira, Figma, Project Atlas, or another source that needs special evidence handling.
- Jira: use `get_jira_authoring_bundle` first.
- Figma: preserve exact file/node evidence.
- Atlas: use only for architecture, module boundaries, uncertain targets, cross-module impact, or read order.
Do not require Project Atlas for simple single-file or clearly targeted cards.

## Decomposition
Load `06-authoring-decomposition` only for large work, parent/child authoring, frontend/backend splits, or when a checklist is starting to hide independent implementation units.

## Repository implementation/editing
Load `07-authoring-execution` only when the current action includes local code/file edits, verification, or commit work. Multi-file edits should bootstrap with `read_file_snippets_batch(includeFileRef=true)`; a genuinely single-file edit may use `read_local_file(includeFileRef=true)`.

## Review and existing-task defects
Load `03-reviewer-core` for review, review feedback, corrected review assumptions, and embedded bug guidance. Use `open_task_bug` for a distinct defect on an existing task; do not create a new top-level task unless the user explicitly requests one.

## Schema-only questions
Prefer the live task/tool schema (`get_schema` / `get_tool_schema`). Load `02-schema-reference` only for semantic placement that schemas cannot express, such as what belongs in `repoContext` versus `description`.

## Examples
Load `04-examples` only when a concrete sample, complex task patch, or parent/child example is useful.

## General rules
- Master skills define behavior; examples are reference material.
- Keep portable metadata repo-relative. Never hardcode developer-specific absolute local repo paths.
- Do not retry the same failed payload unchanged; change the strategy, payload, identifier, or evidence first.
- Server-side mutation validation is authoritative. Explicit preflight validation is optional diagnostic/preview guidance, not a mandatory duplicate round trip.
