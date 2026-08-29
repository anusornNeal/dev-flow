import test from 'node:test';
import assert from 'node:assert/strict';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { devFlowToolDefinitions } from '../../src/server/contracts/devflowContract.js';
import { buildMcpToolSurfaceInventory } from '../../src/server/contracts/mcpToolSurfaceClassification.js';
import { toMutationResponse } from '../../src/server/routes/taskRouteSupport.js';

test('compact mutation responses preserve authoritative lifecycle routing identity', () => {
  const task = { id: 'task-1', displayId: 'DVF-0001', status: 'in-progress', projectId: 'project-1' };
  const payload = {
    task,
    claim: { ownershipEpochId: 'claim-epoch-test' },
    workspace: { workspaceId: 'ws_test', branch: '0001', state: 'ready' },
    executionSessionId: 'exec-test',
  };
  for (const responseMode of ['ack', 'summary']) {
    const response = toMutationResponse({ query: { responseMode } } as any, task, payload) as any;
    assert.equal(response.workspaceId, 'ws_test');
    assert.equal(response.executionSessionId, 'exec-test');
    assert.equal(response.ownershipEpochId, 'claim-epoch-test');
  }
});

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


test('renew_task_claim is an owner-guarded bounded lease-renewal write intent', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'renew_task_claim');
  assert.ok(tool);
  assert.match(String(tool.description || ''), /never resurrects an expired or foreign claim/);
  const schema = tool.inputSchema as any;
  assert.equal(schema?.properties?.sessionId?.type, 'string');
  assert.equal(schema?.properties?.ttlMs?.type, 'number');
  assert.ok(schema?.required?.includes('taskId'));
  assert.ok(schema?.required?.includes('sessionId'));
  const request = tool.buildHttpRequest({ taskId: 'DVF-0786', sessionId: 'worker-a', ttlMs: 120_000 });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/tasks/DVF-0786/claim/renew?responseMode=summary');
  assert.equal((request.body as any)?.sessionId, 'worker-a');
  assert.equal((request.body as any)?.ttlMs, 120_000);
  assert.ok(devFlowToolDefinitions.some((entry) => entry.name === 'renew_task_claim'));
  const inventory = buildMcpToolSurfaceInventory(taskToolDefinitions);
  const classification = inventory.find((entry) => entry.name === 'renew_task_claim');
  assert.equal(classification?.risk, 'write');
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

test('get_next_action is a read-only project-pinned scheduler contract with no implicit claim', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'get_next_action');
  assert.ok(tool);
  const schema = tool.inputSchema as any;
  assert.equal(schema?.properties?.projectId?.type, 'string');
  assert.equal(schema?.properties?.sessionId?.type, 'string');
  assert.ok(schema?.required?.includes('projectId'));
  assert.ok(schema?.required?.includes('sessionId'));
  assert.deepEqual(schema?.properties?.action, undefined);
  const request = tool.buildHttpRequest({ projectId: 'project-1', sessionId: 'chat-a', limit: 25 });
  assert.equal(request.method, 'POST');
  assert.equal(request.path, '/api/tasks/next-action');
  assert.equal((request.body as any)?.projectId, 'project-1');
  assert.equal((request.body as any)?.sessionId, 'chat-a');
  assert.match(String(tool.description || ''), /Read-only/i);
  assert.match(String(tool.description || ''), /never claims/i);
  assert.match(String(tool.description || ''), /repeated pulls are safe/i);
  const inventory = buildMcpToolSurfaceInventory(taskToolDefinitions);
  assert.equal(inventory.find((entry) => entry.name === 'get_next_action')?.risk, 'read');
  assert.ok(devFlowToolDefinitions.some((entry) => entry.name === 'get_next_action'));
});

test('scheduler contracts expose durable board-loop start and stop-confirmation semantics without making get_next_action a write', () => {
  const next = taskToolDefinitions.find((entry) => entry.name === 'get_next_action')!;
  const claimNext = taskToolDefinitions.find((entry) => entry.name === 'claim_next_task')!;
  const claimSchema = claimNext.inputSchema as any;
  const nextOutput = next.outputSchema as any;

  assert.equal(claimSchema?.properties?.boardLoopRequested?.type, 'boolean');
  assert.equal(claimSchema?.properties?.requestedTaskId?.type, 'string');
  assert.deepEqual(claimSchema?.properties?.selectionPolicy?.enum, ['todo-only', 'include-backlog']);
  assert.equal(claimSchema?.properties?.partitionCount?.type, 'number');
  assert.equal(claimSchema?.properties?.partitionIndex?.type, 'number');
  assert.equal((next.inputSchema as any)?.properties?.partitionCount?.type, 'number');
  assert.equal((next.inputSchema as any)?.properties?.partitionIndex?.type, 'number');
  assert.match(String(claimNext.description || ''), /durable[\s\S]*board-loop|board-loop[\s\S]*durable/i);
  assert.ok(nextOutput?.properties?.action?.enum?.includes('confirm-loop-stop'));
  assert.equal(nextOutput?.properties?.loop?.type, 'object');
  assert.match(String(next.description || ''), /resume[\s\S]*board-loop|board-loop[\s\S]*resume/i);

  const request = claimNext.buildHttpRequest({
    projectId: 'project-1',
    sessionId: 'fresh-worker',
    boardLoopRequested: true,
    requestedTaskId: 'DVF-100',
    selectionPolicy: 'include-backlog',
    partitionCount: 3,
    partitionIndex: 1,
    limit: 25,
  });
  assert.equal((request.body as any)?.boardLoopRequested, true);
  assert.equal((request.body as any)?.requestedTaskId, 'DVF-100');
  assert.equal((request.body as any)?.selectionPolicy, 'include-backlog');
  assert.equal((request.body as any)?.partitionCount, 3);
  assert.equal((request.body as any)?.partitionIndex, 1);

  const inventory = buildMcpToolSurfaceInventory(taskToolDefinitions);
  assert.equal(inventory.find((entry) => entry.name === 'get_next_action')?.risk, 'read');
});

test('claim_next_task is a bounded project-level optimization with explicit session identity', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'claim_next_task');
  assert.ok(tool);
  assert.equal((tool.inputSchema as any)?.properties?.projectId?.type, 'string');
  assert.equal((tool.inputSchema as any)?.properties?.sessionId?.type, 'string');
  assert.equal((tool.inputSchema as any)?.properties?.partitionCount?.type, 'number');
  assert.equal((tool.inputSchema as any)?.properties?.partitionIndex?.type, 'number');
  assert.ok((tool.inputSchema as any)?.required?.includes('projectId'));
  assert.ok((tool.inputSchema as any)?.required?.includes('sessionId'));
  assert.equal((tool.inputSchema as any)?.required?.includes('taskId'), false);
  const request = tool.buildHttpRequest({ projectId: 'project-1', sessionId: 'chat-a', limit: 25 });
  assert.equal(request.path, '/api/tasks/claim-next?responseMode=summary');
  const body = request.body as any;
  assert.equal(body.projectId, 'project-1');
  assert.equal(body.sessionId, 'chat-a');
  assert.equal(body.limit, 25);
  const partitioned = tool.buildHttpRequest({ projectId: 'project-1', sessionId: 'chat-a', limit: 25, partitionCount: 3, partitionIndex: 1 });
  assert.equal((partitioned.body as any).partitionCount, 3);
  assert.equal((partitioned.body as any).partitionIndex, 1);
  assert.match(String(tool.description || ''), /bounded[\s\S]*minimal\/summary/i);
  assert.match(String(tool.description || ''), /todo-only[\s\S]*include-backlog/i);
  assert.match(String(tool.description || ''), /Explicit claim_task[\s\S]*backlog/i);
  assert.match(String(tool.description || ''), /Generic all\/continue[\s\S]*does not imply backlog/i);
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
