import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { workspaceFinalizationHttpStatus } from '../../src/server/routes/devflow.js';
import { CLOSURE_CRITICAL_RECOVERY_CAPABILITIES, devFlowToolDefinitions, getCapabilityCatalog, getMcpToolList, getToolDefinitionByName, isToolAllowedInProfile } from '../../src/server/contracts/devflowContract.js';
import { taskToolDefinitions } from '../../src/server/contracts/devflowTaskTools.js';
import { gitToolDefinitions } from '../../src/server/contracts/devflowGitTools.js';
import { workspaceToolDefinitions } from '../../src/server/contracts/devflowWorkspaceTools.js';
import { emergencyToolDefinitions } from '../../src/server/contracts/devflowEmergencyTools.js';

const TASK_TOOL_NAMES = [
  'continue_task_execution_tail', 'get_execution_continuation',
  'list_tasks', 'search_tasks', 'get_task', 'get_task_images',
  'open_task_bug', 'update_task_bug_status', 'create_task', 'update_task', 'get_next_action', 'claim_next_task', 'claim_task', 'renew_task_claim', 'expand_task_scope', 'release_task_claim', 'batch_upsert_tasks', 'import_tasks_from_file',
  'sync_task_with_git', 'submit_task_for_review', 'update_external_task_status', 'move_task_status', 'move_task_to_status',
  'batch_move_task_status', 'toggle_task_checklist', 'batch_toggle_task_checklist', 'delete_task',
];

const GIT_TOOL_NAMES = [
  'get_git_log', 'get_git_diff', 'get_git_show', 'get_git_status', 'get_change_summary', 'get_git_branch',
  'ensure_git_branch', 'push_git_branch', 'get_git_sync_status', 'create_pull_request', 'plan_task_commit', 'adopt_task_execution_owned_changes', 'reconcile_task_owned_revision_drift', 'commit_task_owned_changes', 'commit_git_changes',
];

test('task-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  const create = taskToolDefinitions.find((tool) => tool.name === 'create_task')!;
  const update = taskToolDefinitions.find((tool) => tool.name === 'update_task')!;
  assert.equal((create.inputSchema as any).properties.prerequisiteTaskIds.type, 'array');
  assert.equal((create.inputSchema as any).properties.taskSetKey.type, 'string');
  assert.equal((update.inputSchema as any).properties.prerequisiteTaskIds.type, 'array');
  assert.match(String(taskToolDefinitions.find((tool) => tool.name === 'claim_next_task')?.description || ''), /prerequisiteTaskIds/);

  assert.deepEqual(taskToolDefinitions.map((tool) => tool.name), TASK_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(TASK_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + TASK_TOOL_NAMES.length), TASK_TOOL_NAMES);
});

test('task scope expansion keeps a first-class owner-guarded mutation contract', () => {
  const tool = taskToolDefinitions.find((entry) => entry.name === 'expand_task_scope');
  assert.ok(tool);
  assert.equal((tool?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('sessionId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('paths'), true);
  const req = tool?.buildHttpRequest({ taskId: 'DVF-1', sessionId: 'chat-secret', paths: ['src/New.ts'] });
  assert.equal(req?.method, 'POST');
  assert.equal(req?.path, '/api/tasks/DVF-1/claim/scope?responseMode=summary');
  assert.deepEqual((req?.body as any)?.paths, ['src/New.ts']);
});

test('task Git workflow contracts expose opaque workspace provenance inputs', () => {
  for (const toolName of ['sync_task_with_git', 'submit_task_for_review']) {
    const tool = taskToolDefinitions.find((entry) => entry.name === toolName);
    assert.ok(tool, `${toolName} contract must exist`);
    const workspaceId = (tool?.inputSchema as any)?.properties?.workspaceId;
    assert.equal(workspaceId?.type, 'string', `${toolName} must expose workspaceId as a string`);
    assert.match(String(workspaceId?.description || ''), /workspace/i);
  }
});

test('git-domain contracts are owned by a focused module and composed into the aggregate catalog', () => {
  assert.deepEqual(gitToolDefinitions.map((tool) => tool.name), GIT_TOOL_NAMES);
  const aggregateNames = devFlowToolDefinitions.map((tool) => tool.name);
  const first = aggregateNames.indexOf(GIT_TOOL_NAMES[0]);
  assert.ok(first >= 0);
  assert.deepEqual(aggregateNames.slice(first, first + GIT_TOOL_NAMES.length), GIT_TOOL_NAMES);
});

test('task-aware commit tools expose scoped planning and async commit wiring', () => {
  const plan = gitToolDefinitions.find((tool) => tool.name === 'plan_task_commit');
  const adopt = gitToolDefinitions.find((tool) => tool.name === 'adopt_task_execution_owned_changes');
  const reconcile = gitToolDefinitions.find((tool) => tool.name === 'reconcile_task_owned_revision_drift');
  const commit = gitToolDefinitions.find((tool) => tool.name === 'commit_task_owned_changes');
  assert.equal(plan?.lightweight, true);
  assert.equal((plan?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((plan?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((adopt?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((adopt?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((adopt?.inputSchema as any)?.required?.includes('executionSessionId'), true);
  assert.equal((adopt?.inputSchema as any)?.required?.includes('files'), true);
  assert.equal((adopt?.inputSchema as any)?.required?.includes('reason'), true);
  assert.equal((adopt?.inputSchema as any)?.properties?.files?.items?.additionalProperties, false);
  assert.equal((adopt?.inputSchema as any)?.properties?.files?.items?.properties?.path?.minLength, 1);
  assert.equal((adopt?.inputSchema as any)?.properties?.files?.items?.properties?.expectedRevision?.minLength, 1);
  assert.match(String(adopt?.description || ''), /dirty\/unowned|revision-guarded/i);
  assert.equal(adopt?.buildHttpRequest({ taskId: 'DVF-1', workspaceId: 'ws_1', executionSessionId: 'exec_1', files: [{ path: 'src/A.ts', expectedRevision: 'rev-1' }], reason: 'recover preserved wip' }).path, '/api/git/task-commit/adopt-owned-changes');
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('executionSessionId'), true);
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('files'), true);
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('reason'), true);
  assert.equal((reconcile?.inputSchema as any)?.required?.includes('provenance'), true);
  assert.match(String(reconcile?.description || ''), /already-owned|owned files/i);
  assert.equal(reconcile?.buildHttpRequest({ taskId: 'DVF-1', workspaceId: 'ws_1', executionSessionId: 'exec_1', files: [], reason: 'audit reason', provenance: 'fixture' }).path, '/api/git/task-commit/reconcile-owned-revisions');
  assert.equal((commit?.executionPolicy as any)?.mode, 'job');
  assert.equal((commit?.inputSchema as any)?.required?.includes('message'), true);
  assert.equal((commit?.inputSchema as any)?.properties?.preserveVerificationDebt, undefined);
  assert.equal((commit?.inputSchema as any)?.properties?.emergency, undefined);
  assert.equal((commit?.inputSchema as any)?.properties?.reason, undefined);
  assert.equal((commit?.inputSchema as any)?.properties?.actorLabel, undefined);
  const messageDescription = String((commit?.inputSchema as any)?.properties?.message?.description || '');
  assert.match(messageDescription, /conventional/i);
  assert.match(messageDescription, /task|ticket|card/i);
  const routeSource = fs.readFileSync('src/server/routes/devflow.ts', 'utf8');
  assert.match(routeSource, /\/api\/git\/task-commit\/plan/);
  assert.match(routeSource, /\/api\/git\/task-commit\/reconcile-owned-revisions/);
  assert.match(routeSource, /\/api\/git\/task-commit\/commit/);
});

test('workspace finalization is a first-class local-only terminal tool', () => {
  const tool = workspaceToolDefinitions.find((entry) => entry.name === 'finalize_task_workspace');
  assert.ok(tool);
  assert.equal((tool?.inputSchema as any)?.required?.includes('workspaceId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('taskId'), true);
  assert.equal((tool?.inputSchema as any)?.required?.includes('checks'), false);
  const completedChecklistIds = (tool?.inputSchema as any)?.properties?.completedChecklistIds;
  assert.equal((tool?.inputSchema as any)?.required?.includes('completedChecklistIds'), false);
  assert.equal(completedChecklistIds?.type, 'array');
  assert.equal(completedChecklistIds?.maxItems, 100);
  assert.equal(completedChecklistIds?.uniqueItems, true);
  assert.ok((tool?.inputSchema as any)?.properties?.operationId);
  assert.equal((tool?.inputSchema as any)?.required?.includes('operationId'), false);
  assert.match(String(tool?.description || ''), /Never pushes or fetches/i);
  const request = tool?.buildHttpRequest({ taskId: 'DVF-1', workspaceId: 'ws_1', checks: [], completedChecklistIds: ['done'] });
  assert.equal(request?.path, '/api/workspaces/finalize-task');
  assert.deepEqual((request as any)?.body?.completedChecklistIds, ['done']);
});

test('workspace finalization transport preserves verification continuation without weakening hard conflicts', () => {
  assert.equal(workspaceFinalizationHttpStatus({ status: 'completed' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'cleanup-pending', code: 'FINALIZATION_CLEANUP_PENDING' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'continuation', code: 'POST_INTEGRATION_VERIFICATION_REQUIRED' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'continuation', code: 'POST_INTEGRATION_FINALIZATION_REQUIRED' }), 200);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'needs-recovery', code: 'INTEGRATION_CONFLICT' }), 409);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'needs-recovery', code: 'WORKSPACE_DIRTY' }), 409);
  assert.equal(workspaceFinalizationHttpStatus({ status: 'blocked', code: 'VERIFICATION_NOT_PASSED' }), 409);
});

test('break-glass lifecycle is exposed as one coherent audited mutation plus bounded read surface', () => {
  assert.deepEqual(emergencyToolDefinitions.map((tool) => tool.name), [
    'break_glass_lifecycle',
    'cleanup_orphan_executions',
    'get_break_glass_operations',
  ]);
  const tool = emergencyToolDefinitions[0];
  const required = (tool.inputSchema as any).required || [];
  for (const field of ['operationId', 'action', 'reason', 'actorLabel', 'projectId', 'taskId']) assert.ok(required.includes(field), field);
  assert.equal((tool.inputSchema as any).properties.destructiveAck.type, 'boolean');
  assert.match(String(tool.description || ''), /audited|reason/i);
  assert.equal(tool.buildHttpRequest({ operationId: 'op', action: 'release-ownership-preserve-wip', reason: 'operator', actorLabel: 'human', projectId: 'p', taskId: 't' }).path, '/api/lifecycle/break-glass');
  const aggregateNames = devFlowToolDefinitions.map((entry) => entry.name);
  assert.ok(aggregateNames.includes('break_glass_lifecycle'));
  assert.ok(aggregateNames.includes('get_break_glass_operations'));
  assert.ok(aggregateNames.includes('cleanup_orphan_executions'));
  const routeSource = fs.readFileSync('src/server/routes/devflow.ts', 'utf8');
  assert.match(routeSource, /\/api\/lifecycle\/break-glass/);
  assert.match(routeSource, /\/api\/lifecycle\/orphan-executions\/cleanup/);
});

test('closure-critical recovery capabilities are callable end-to-end in the coding profile', () => {
  const routeSource = fs.readFileSync('src/server/routes/devflow.ts', 'utf8');
  const codingNames = new Set(getMcpToolList('coding').map((entry: any) => entry.name));
  assert.deepEqual(CLOSURE_CRITICAL_RECOVERY_CAPABILITIES.map((entry) => entry.id), [
    'recovery-handoff',
    'orphan-cleanup',
    'task-commit-plan',
    'preserved-wip-adoption',
    'owned-revision-reconciliation',
    'task-owned-commit',
    'verification-batch-supersession',
    'task-finalization',
    'audited-break-glass',
  ]);

  for (const capability of CLOSURE_CRITICAL_RECOVERY_CAPABILITIES) {
    const definition = getToolDefinitionByName(capability.toolName);
    assert.ok(definition, `${capability.toolName} must have a contract definition`);
    assert.equal(isToolAllowedInProfile(capability.toolName, 'coding'), true, `${capability.toolName} must be allowed in coding profile`);
    assert.equal(codingNames.has(capability.toolName), true, `${capability.toolName} must be advertised in coding MCP surface`);
    assert.match(routeSource, new RegExp(capability.route.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')));
    assert.ok(definition?.inputSchema, `${capability.toolName} must expose an exact input schema`);
    if ('requiredInputPaths' in capability) {
      assert.deepEqual(capability.requiredInputPaths, ['verificationBatch.supersedesBatchId', 'verificationBatch.supersessionReason']);
      const batch = (definition?.inputSchema as any)?.properties?.verificationBatch;
      assert.equal(batch?.properties?.supersedesBatchId?.type, 'string');
      assert.equal(batch?.properties?.supersessionReason?.type, 'string');
      assert.equal(batch?.additionalProperties, false);
    }
  }
});

test('capability catalog reports closure recovery readiness from the active advertised tool surface', () => {
  const catalog = getCapabilityCatalog() as any;
  const activeNames = new Set(getMcpToolList(catalog.mcpProfile.active).map((entry: any) => entry.name));
  assert.equal(catalog.recovery?.scope, 'server-advertised');
  assert.equal(catalog.recovery?.serverReady, true);
  assert.equal(catalog.recovery?.ready, true);
  assert.deepEqual(catalog.recovery?.missingCapabilityIds, []);
  assert.equal(catalog.recovery?.toolSurfaceIdentity, catalog.mcpProfile.toolSurfaceIdentity);
  for (const capability of CLOSURE_CRITICAL_RECOVERY_CAPABILITIES) {
    const state = catalog.recovery?.capabilities?.find((entry: any) => entry.id === capability.id);
    assert.equal(state?.advertised, activeNames.has(capability.toolName));
    assert.equal(state?.callable, true, `${capability.id} must be callable on active surface`);
  }
});

test('task-domain aliases remain available through focused definitions', () => {
  assert.deepEqual(taskToolDefinitions.find((tool) => tool.name === 'open_task_bug')?.aliases, ['create_bug_thread', 'add_task_bug']);
});
