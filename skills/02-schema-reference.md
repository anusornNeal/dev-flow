# DevFlow Schema Semantic Reference

## Purpose
Use this skill only for semantic task-field placement that a structural tool schema cannot express. It does not maintain a second task schema.

## Structural source of truth
`get_tool_schema` is authoritative for live tool input/output structure, including field types, required fields, enums, aliases, and nested shapes. For task mutations, inspect the live `create_task` or `update_task` schema when exact structure matters.

If this document conflicts with a live schema, follow the live schema and correct this document. Do not copy changing model, status, effort, or tool-shape catalogs into this file.

## Semantic field placement
### `description`
State requested behavior, the scope delta, and important exclusions. Keep code archaeology out unless it changes the observable requirement.

### `repoContext`
Put current repository findings, implementation guidance, dependencies, and constraints here. An implementation-ready card should normally include a compact Implementation map:

```text
Implementation map:
- File: <repo-relative path>
  Class/function: <symbol when known>
  Current behavior: <evidence>
  Expected change: <delta>
```

Use repository-relative paths. Do not persist machine-specific workspace paths.

### `targetFiles`
List focused repo-relative implementation and test files supported by the implementation map. Do not use this field as a speculative directory dump.

### `checklist`
Use for milestones inside one coherent card boundary. Independently executable or reviewable work belongs in child cards instead of a long checklist.

### `acceptanceCriteria`
Describe observable pass/fail outcomes. Include negative cases or preserved behavior when they are material to correctness.

### `verification`
State concrete automated, manual, or evidence-based checks and what they prove. Keep command/tool mechanics in execution guidance rather than duplicating them here.

### `reasoning`
Record why the chosen scope, decomposition, or implementation boundary is appropriate when that context helps a future implementer or reviewer.

### `parentId`
Use only for a real parent/child implementation relationship. It is not a general topic-grouping field.

### Source and design provenance
Use Jira, Figma, specification, image, or source fields for provenance when the live task schema exposes them. Summarize implementation-relevant conclusions in `repoContext` instead of relying on an external link as the only task instruction.

## Status semantics
New authoring defaults to backlog unless the user or workflow explicitly queues or starts implementation. Implementation readiness alone does not mean work has started.

## Mutation semantics
Server-side create/update validation is authoritative. Do not add a duplicate validation round trip merely because this semantic reference exists.
