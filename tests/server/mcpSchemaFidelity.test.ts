import test from 'node:test';
import assert from 'node:assert/strict';
import { getMcpToolList, getToolDefinitionByName } from '../../src/server/contracts/devflowContract.js';
import { buildMcpTransportInputSchema } from '../../src/server/contracts/mcpSchemaTransport.js';
import { createDevFlowMcpServer } from '../../src/server/mcp.js';

function requireObject(value: any, path: string) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Schema mismatch at ${path}: expected object`);
  return value as Record<string, any>;
}

function assertPropertyMatches(canonicalProperties: Record<string, any>, exposedProperties: Record<string, any> | undefined, key: string, path: string) {
  assert.ok(exposedProperties?.[key], `Schema mismatch at ${path}.properties.${key}: missing exposed property`);
  assert.deepEqual(
    exposedProperties[key],
    canonicalProperties[key],
    `Schema mismatch at ${path}.properties.${key}: exposed schema diverges from canonical schema`,
  );
}

test('read_file_snippets_batch keeps per-entry fields inside every exposed anyOf branch', () => {
  const canonical = getToolDefinitionByName('read_file_snippets_batch');
  assert.ok(canonical);
  const exposed = getMcpToolList('full').find((tool: any) => tool.name === 'read_file_snippets_batch');
  assert.ok(exposed);

  const canonicalItems = requireObject(canonical.inputSchema.properties.files.items, 'canonical.read_file_snippets_batch.inputSchema.properties.files.items');
  const exposedItems = requireObject(exposed.inputSchema.properties.files.items, 'read_file_snippets_batch.inputSchema.properties.files.items');
  assert.equal(exposedItems.properties, undefined, 'Schema mismatch at read_file_snippets_batch.inputSchema.properties.files.items.properties: transport schema should not retain redundant parent properties after materializing union branches');
  const canonicalProperties = requireObject(canonicalItems.properties, 'canonical.read_file_snippets_batch.inputSchema.properties.files.items.properties');
  const branches = exposedItems.anyOf;
  assert.ok(Array.isArray(branches) && branches.length === 2, 'Schema mismatch at read_file_snippets_batch.inputSchema.properties.files.items.anyOf: expected two alias branches');

  const expectedKeys = ['filePath', 'path', 'mode', 'startLine', 'endLine', 'maxBytes', 'responseMode', 'includeFileRef'];
  branches.forEach((branch: any, index: number) => {
    const branchPath = `read_file_snippets_batch.inputSchema.properties.files.items.anyOf[${index}]`;
    const branchObject = requireObject(branch, branchPath);
    for (const key of expectedKeys) {
    assert.deepEqual(branchObject.required, [index === 0 ? 'filePath' : 'path'], `Schema mismatch at ${branchPath}.required`);
      assertPropertyMatches(canonicalProperties, branchObject.properties, key, branchPath);
    }
  });
});

test('run_project_command exposes bounded sequential verification batch identity', () => {
  const canonical = getToolDefinitionByName('run_project_command');
  assert.ok(canonical);
  const batch = canonical.inputSchema.properties.verificationBatch;
  assert.ok(batch, 'run_project_command must expose verificationBatch');
  assert.equal(batch.type, 'object');
  assert.deepEqual(batch.required, ['id', 'requiredChecks', 'checkId']);
  assert.equal(batch.properties.id.maxLength, 160);
  assert.equal(batch.properties.requiredChecks.maxItems, 64);
  assert.equal(batch.properties.requiredChecks.items.maxLength, 200);
  assert.equal(batch.properties.checkId.maxLength, 200);
});

test('run_project_command exposes server-owned verification reuse with an unconditional forceFresh override', () => {
  const canonical = getToolDefinitionByName('run_project_command');
  assert.ok(canonical);
  const properties = canonical.inputSchema.properties;
  assert.equal(properties.forceFresh?.type, 'boolean');
  assert.match(String(properties.forceFresh?.description || ''), /bypass reusable verification evidence/i);
  assert.match(String(properties.cacheResult?.description || ''), /omitted[\s\S]*server policy[\s\S]*reuse/i);
});

test('transport normalization preserves nested objects, arrays, enums, descriptions, required fields, and optional fields without redundant parent properties', () => {
  const fixture = {
    type: 'object',
    description: 'Representative tool input.',
    properties: {
      primary: { type: 'string', description: 'Primary selector.' },
      alias: { type: 'string', description: 'Alias selector.' },
      entries: {
        type: 'array',
        description: 'Nested entries.',
        items: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Canonical path.' },
            path: { type: 'string', description: 'Path alias.' },
            mode: { type: 'string', enum: ['compact', 'standard'], description: 'Response mode.' },
            note: { type: 'string', description: 'Optional note.' },
          },
          anyOf: [{ required: ['filePath'] }, { required: ['path'] }],
        },
      },
    },
    required: ['entries'],
    anyOf: [{ required: ['primary'] }, { required: ['alias'] }],
  };
  const before = structuredClone(fixture);
  const expectedOuterProperties = requireObject(
    buildMcpTransportInputSchema({ type: 'object', properties: fixture.properties }).properties,
    'fixture.expected.properties',
  );
  const expectedItemProperties = requireObject(
    buildMcpTransportInputSchema({ type: 'object', properties: fixture.properties.entries.items.properties }).properties,
    'fixture.expected.entries.items.properties',
  );

  const exposed = buildMcpTransportInputSchema(fixture);
  const repeated = buildMcpTransportInputSchema(fixture);

  assert.equal(repeated, exposed, 'unchanged canonical schema should reuse its normalized transport materialization');
  assert.equal(Object.isFrozen(exposed), true, 'cached transport schema should be immutable');
  assert.deepEqual(fixture, before, 'canonical fixture must not be mutated');
  assert.equal(exposed.properties, undefined, 'Schema mismatch at fixture.inputSchema.properties: materialized union should not duplicate shared parent properties');
  assert.equal(exposed.required, undefined, 'Schema mismatch at fixture.inputSchema.required: parent required fields should move into materialized branches');
  exposed.anyOf.forEach((branch: any, index: number) => {
    const branchPath = `fixture.inputSchema.anyOf[${index}]`;
    const branchObject = requireObject(branch, branchPath);
    const branchProperties = requireObject(branchObject.properties, `${branchPath}.properties`);
    for (const key of ['primary', 'alias', 'entries']) {
      assertPropertyMatches(expectedOuterProperties, branchProperties, key, branchPath);
    }
    assert.deepEqual(
      branchObject.required,
      index === 0 ? ['entries', 'primary'] : ['entries', 'alias'],
      `Schema mismatch at ${branchPath}.required`,
    );

    const itemSchema = requireObject(branchProperties.entries.items, `${branchPath}.properties.entries.items`);
    assert.equal(itemSchema.properties, undefined, `Schema mismatch at ${branchPath}.properties.entries.items.properties: nested union should not duplicate shared parent properties`);
    itemSchema.anyOf.forEach((itemBranch: any, itemIndex: number) => {
      const itemBranchPath = `${branchPath}.properties.entries.items.anyOf[${itemIndex}]`;
      const itemBranchObject = requireObject(itemBranch, itemBranchPath);
      for (const key of ['filePath', 'path', 'mode', 'note']) {
        assertPropertyMatches(expectedItemProperties, itemBranchObject.properties, key, itemBranchPath);
      }
      assert.deepEqual(itemBranchObject.properties.mode.enum, ['compact', 'standard'], `Schema mismatch at ${itemBranchPath}.properties.mode.enum`);
      assert.equal(itemBranchObject.properties.mode.description, 'Response mode.', `Schema mismatch at ${itemBranchPath}.properties.mode.description`);
      assert.deepEqual(itemBranchObject.required, [itemIndex === 0 ? 'filePath' : 'path'], `Schema mismatch at ${itemBranchPath}.required`);
    });
  });
});

test('transport generation does not mutate the canonical read_file_snippets_batch schema', () => {
  const canonical = getToolDefinitionByName('read_file_snippets_batch');
  assert.ok(canonical);
  const before = structuredClone(canonical.inputSchema);

  getMcpToolList('full');

  assert.deepEqual(canonical.inputSchema, before);
  const canonicalItems = requireObject(canonical.inputSchema.properties.files.items, 'canonical.read_file_snippets_batch.inputSchema.properties.files.items');
  assert.equal(canonicalItems.anyOf[0].properties, undefined, 'canonical schema should remain DRY; branch materialization belongs to MCP transport only');
});

test('schema fidelity assertion reports the exact divergent property path', () => {
  assert.throws(
    () => assertPropertyMatches({ mode: { type: 'string' } }, {}, 'mode', 'fixture.inputSchema.anyOf[1]'),
    /fixture\.inputSchema\.anyOf\[1\]\.properties\.mode/,
  );
});

test('full MCP tools/list exposes the same transport-safe schemas including aliases', async () => {
  const previousProfile = process.env.DEVFLOW_MCP_TOOL_PROFILE;
  process.env.DEVFLOW_MCP_TOOL_PROFILE = 'full';
  try {
    const server = createDevFlowMcpServer('http://127.0.0.1:3000');
    const handler = (server as any)._requestHandlers.get('tools/list');
    assert.ok(handler, 'MCP tools/list handler should be registered');

    const response = await handler({ method: 'tools/list', params: {} });
    const listedTools = response.tools as any[];
    const directTools = getMcpToolList('full') as any[];
    for (const name of ['read_file_snippets_batch', 'apply_and_verify', 'get_agent_task_context', 'get_agent_context']) {
      const listed = listedTools.find((tool) => tool.name === name);
      const direct = directTools.find((tool) => tool.name === name);
      assert.ok(listed, `Schema mismatch at tools/list.${name}: tool missing from MCP registration`);
      assert.ok(direct, `Schema mismatch at direct.${name}: tool missing from canonical exposure list`);
      assert.deepEqual(listed.inputSchema, direct.inputSchema, `Schema mismatch at tools/list.${name}.inputSchema`);
    }

    const canonicalAgentTool = listedTools.find((tool) => tool.name === 'get_agent_task_context');
    const aliasAgentTool = listedTools.find((tool) => tool.name === 'get_agent_context');
    assert.deepEqual(aliasAgentTool.inputSchema, canonicalAgentTool.inputSchema, 'Schema mismatch at tools/list.get_agent_context.inputSchema: alias diverges from canonical tool');
  } finally {
    if (previousProfile === undefined) delete process.env.DEVFLOW_MCP_TOOL_PROFILE;
    else process.env.DEVFLOW_MCP_TOOL_PROFILE = previousProfile;
  }
});
