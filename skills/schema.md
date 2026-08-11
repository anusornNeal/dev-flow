# DevFlow Schema Compatibility Reference

## Compatibility role
This legacy document path is retained for compatibility with older references. It is not a maintained copy of the DevFlow task or MCP schema.

For structural truth, call `get_tool_schema` for the exact current tool, especially `create_task` or `update_task` when authoring task payloads. Live tool schemas own field types, required values, enums, aliases, and nested shapes.

For semantic task-field placement—such as what belongs in `description`, `repoContext`, `targetFiles`, `acceptanceCriteria`, or `verification`—load `02-schema-reference`.

For ordinary authoring policy, source evidence, decomposition, review, examples, execution, and board orchestration, use the routed 00–08 master skills instead of expanding this compatibility file.

If this document conflicts with a live schema or a canonical master skill, the live schema/canonical owner wins. Do not add model lists, status catalogs, effort matrices, full task JSON shapes, or authoring policy here.
