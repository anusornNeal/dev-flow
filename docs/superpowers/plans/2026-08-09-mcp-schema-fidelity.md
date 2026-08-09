# MCP Schema Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure DevFlow's model-visible MCP input schemas preserve the capabilities and metadata present in canonical tool contracts, including nested union-object fields such as `read_file_snippets_batch.files[].startLine/endLine/maxBytes`.

**Architecture:** Keep canonical contract schemas unchanged and expressive. Add a focused MCP transport-schema normalizer that recursively materializes shared object properties/required fields into `anyOf` object branches so downstream schema converters cannot collapse a union to required-only aliases; once every branch is safely materialized, remove redundant parent `properties`/`required` copies to limit payload growth. `getMcpToolList` applies that normalizer only at exposure time, while tests exercise both the normalizer and the actual MCP `tools/list` handler.

**Tech Stack:** TypeScript, Node.js `node:test`, `@modelcontextprotocol/sdk`, existing DevFlow contract registry.

## Global Constraints

- Work only in the isolated DevFlow session worktree for `DVF-0390`.
- Preserve canonical contract behavior and HTTP request mapping.
- Do not push unless the user explicitly asks.
- Follow TDD: failing regression first, then minimal implementation, then refactor while green.
- Keep the new schema transformation in a focused module rather than adding substantial helper logic to the already-large `devflowContract.ts`.
- Fidelity checks must identify the exact divergent schema/property path.

---

### Task 1: Add schema-fidelity regression coverage

**Files:**
- Create: `tests/server/mcpSchemaFidelity.test.ts`
- Read: `src/server/contracts/devflowContract.ts`
- Read: `src/server/mcp.ts`

**Interfaces:**
- Consumes: `getToolDefinitionByName(name)`, `getMcpToolList(profile)`, `createDevFlowMcpServer(baseUrl)`.
- Produces: regression expectations for nested arrays/objects, `anyOf` unions, enums, descriptions, required fields, aliases, and actionable mismatch paths.

- [ ] **Step 1: Write a failing transport-safety test**

Create a representative union-object fixture and assert that every exposed `anyOf` object branch retains shared property schemas, enum values, descriptions, nested items, and the branch-specific required field. Add an assertion helper whose failure text contains the full schema path.

- [ ] **Step 2: Add the real `read_file_snippets_batch` regression**

Read `getMcpToolList('full')`, locate `read_file_snippets_batch`, and assert that each union branch under `inputSchema.properties.files.items.anyOf` exposes `filePath`, `path`, `mode`, `startLine`, `endLine`, `maxBytes`, `responseMode`, and `includeFileRef`, with the canonical descriptions/enums intact.

- [ ] **Step 3: Verify RED**

Run the focused schema-fidelity test through the repository test runner. Expected failure: a path such as `read_file_snippets_batch.inputSchema.properties.files.items.anyOf[0].properties.startLine` is missing before the transport normalizer exists.

---

### Task 2: Normalize canonical input schemas for MCP transport

**Files:**
- Create: `src/server/contracts/mcpSchemaTransport.ts`
- Modify: `src/server/contracts/devflowContract.ts` near `getMcpToolList`
- Test: `tests/server/mcpSchemaFidelity.test.ts`

**Interfaces:**
- Produces: `buildMcpTransportInputSchema(schema: Record<string, any>): Record<string, any>`.
- Consumes: canonical JSON-schema-like input objects from `DevFlowToolDefinition.inputSchema`.

- [ ] **Step 1: Implement recursive cloning/normalization**

Recursively clone objects and arrays. For an object schema containing both `properties` and object-shaped `anyOf` branches, copy the normalized shared `properties` into each branch, keep branch-specific properties authoritative, ensure the branch has object type when the parent is an object, and merge parent `required` fields with branch `required` fields without duplicates. When every branch can be materialized safely, remove the now-redundant parent `properties`/`required` copies. Preserve descriptions, enums, nested `items`, optional fields, and other schema metadata.

- [ ] **Step 2: Apply normalization at MCP exposure only**

In `getMcpToolList`, compute the transport-safe input schema once per canonical tool and use it for both the canonical tool name and aliases. Do not mutate `tool.inputSchema` and do not change `getToolDefinitionByName`.

- [ ] **Step 3: Verify GREEN**

Run the focused schema-fidelity test. Expected: all new tests pass and canonical schema objects remain unchanged after generating MCP tool lists.

---

### Task 3: Verify actual MCP registration/exposure

**Files:**
- Test: `tests/server/mcpSchemaFidelity.test.ts`
- No production change expected in `src/server/mcp.ts` unless the server list handler diverges from `getMcpToolList`.

**Interfaces:**
- Consumes: `createDevFlowMcpServer()` and its registered `tools/list` request handler.
- Produces: end-to-end evidence that the SDK-facing list result carries the same transport-safe schema as DevFlow's MCP tool list.

- [ ] **Step 1: Add MCP handler comparison test**

Invoke the registered `tools/list` handler, select representative complex tools, and recursively compare schema fields against `getMcpToolList('full')`. On any difference, report the exact tool/property path.

- [ ] **Step 2: Cover aliases and union shapes**

Assert one aliased tool exposes the same input schema as its canonical tool and assert `anyOf` branch structure does not collapse to required-only objects.

- [ ] **Step 3: Run focused MCP contract tests**

Run `mcpSchemaFidelity.test.ts` plus existing MCP/contract regression coverage available in the worktree.

---

### Task 4: Final verification and local commit

**Files:**
- Verify all files changed by Tasks 1-3.

**Interfaces:**
- Produces: verified local commit for `DVF-0390`; no remote push.

- [ ] **Step 1: Run typecheck**

Run DevFlow `typecheck`; expected exit code 0.

- [ ] **Step 2: Run focused tests and inspect diff**

Confirm schema-fidelity tests pass, existing MCP contract tests pass, and the diff contains only DVF-0390 scope.

- [ ] **Step 3: Complete DevFlow checklist evidence**

Mark the four card checklist items complete only after the corresponding tests are green.

- [ ] **Step 4: Create a scoped local commit**

Commit only the plan, schema transport helper, contract wiring, and schema-fidelity tests with a DVF-0390-scoped message. Do not push.
