import test from 'node:test';
import assert from 'node:assert/strict';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { devFlowToolDefinitions } from '../../src/server/contracts/devflowContract.js';
import { buildMcpToolSurfaceInventory } from '../../src/server/contracts/mcpToolSurfaceClassification.js';

test('claim_task and release_task_claim are canonical task tools with required caller session identity', () => {
  for (const toolName of ['claim_task', 'release_task_claim']) {
    const tool = taskToolDefinitions.find((entry) => entry.name === toolName);
    assert.ok(tool, `${toolName} must exist in the task tool catalog`);
    assert.equal((tool.inputSchema as any)?.properties?.sessionId?.type, 'string');
    assert.ok((tool.inputSchema as any)?.required?.includes('taskId'));
    assert.ok((tool.inputSchema as any)?.required?.includes('sessionId'));
    assert.ok(devFlowToolDefinitions.some((entry) => entry.name === toolName), `${toolName} must be exposed in the aggregate MCP catalog`);
  }
});


test('expand_task_scope is a bounded owner-guarded first-class write intent', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'expand_task_scope');
  assert.ok(tool);
  const schema = tool.inputSchema as any;
  assert.equal(schema?.properties?.sessionId?.type, 'string');
  assert.equal(schema?.properties?.paths?.type, 'array');
  assert.equal(schema?.properties?.paths?.minItems, 1);
  assert.equal(schema?.properties?.paths?.maxItems, 100);
  assert.match(String(tool.description || ''), /targetFiles/);
  assert.ok(schema?.required?.includes('taskId'));
  assert.ok(schema?.required?.includes('sessionId'));
  assert.ok(schema?.required?.includes('paths'));
  const request = tool.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-a', paths: ['src/New.ts'] });
  assert.equal(request.path, '/api/tasks/DVF-1/claim/scope?responseMode=summary');
  assert.deepEqual((request.body as any)?.paths, ['src/New.ts']);
  assert.ok(devFlowToolDefinitions.some((entry) => entry.name === 'expand_task_scope'));
  const inventory = buildMcpToolSurfaceInventory(taskToolDefinitions);
  const classification = inventory.find((entry) => entry.name === 'expand_task_scope');
  assert.equal(classification?.classification, 'first-class-intent');
  assert.equal(classification?.disposition, 'keep');
  assert.equal(classification?.risk, 'write');
});

test('claim_next_task is a bounded project-level optimization with explicit session identity', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'claim_next_task');
  assert.ok(tool);
  assert.equal((tool.inputSchema as any)?.properties?.projectId?.type, 'string');
  assert.equal((tool.inputSchema as any)?.properties?.sessionId?.type, 'string');
  assert.ok((tool.inputSchema as any)?.required?.includes('projectId'));
  assert.ok((tool.inputSchema as any)?.required?.includes('sessionId'));
  assert.equal((tool.inputSchema as any)?.required?.includes('taskId'), false);
  const request = tool.buildHttpRequest({ projectId: 'project-1', sessionId: 'chat-a', limit: 25 });
  assert.equal(request.path, '/api/tasks/claim-next?responseMode=summary');
  const body = request.body as any;
  assert.equal(body.projectId, 'project-1');
  assert.equal(body.sessionId, 'chat-a');
  assert.equal(body.limit, 25);
  assert.match(String(tool.description || ''), /bounded[\s\S]*minimal\/summary/i);
  assert.match(String(tool.description || ''), /backlog[\s\S]*todo/i);
  assert.match(String(tool.description || ''), /unfiltered[\s\S]*done[\s\S]*(?:next-work|selection)/i);
  assert.match(String(tool.description || ''), /originating selected board boundary/i);
  assert.match(String(tool.description || ''), /remain unchanged[\s\S]*lifetime of that loop/i);
  assert.match(String(tool.description || ''), /NO_ELIGIBLE_TASK[\s\S]*stops the current project loop/i);
  assert.match(String(tool.description || ''), /do not substitute another projectId/i);
  assert.match(String((tool.inputSchema as any)?.properties?.projectId?.description || ''), /selected board boundary/i);

  assert.ok(devFlowToolDefinitions.some((entry) => entry.name === 'claim_next_task'));
});

test('claim_task maps to the atomic claim route and release maps to owner release route', () => {
  const claim = taskToolDefinitions.find((entry) => entry.name === 'claim_task')!;
  const release = taskToolDefinitions.find((entry) => entry.name === 'release_task_claim')!;
  assert.equal(claim.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-a' }).path, '/api/tasks/DVF-1/claim?responseMode=summary');
  assert.equal(release.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-a' }).path, '/api/tasks/DVF-1/claim/release?responseMode=summary');
});
