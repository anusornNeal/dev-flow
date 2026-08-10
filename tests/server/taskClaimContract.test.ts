import test from 'node:test';
import assert from 'node:assert/strict';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { devFlowToolDefinitions } from '../../src/server/contracts/devflowContract.js';

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

test('claim_task maps to the atomic claim route and release maps to owner release route', () => {
  const claim = taskToolDefinitions.find((entry) => entry.name === 'claim_task')!;
  const release = taskToolDefinitions.find((entry) => entry.name === 'release_task_claim')!;
  assert.equal(claim.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-a' }).path, '/api/tasks/DVF-1/claim?responseMode=summary');
  assert.equal(release.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-a' }).path, '/api/tasks/DVF-1/claim/release?responseMode=summary');
});
