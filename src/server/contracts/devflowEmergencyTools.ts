import { withQuery, type DevFlowToolDefinition } from './devflowContractCore.js';

const actionEnum = [
  'rotate-execution-preserve-wip',
  'release-ownership-preserve-wip',
  'finalize-as-integrated',
  'supersede-execution',
  'supersede-task-work',
  'commit-current-owned-diff',
  'discard-wip',
] as const;

export const emergencyToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'break_glass_lifecycle',
    description: 'Run one explicit audited emergency lifecycle disposition. Requires a stable operationId, human reason, exact task/project identity, action-specific expected identities, and preserves hard project/workspace/cross-worker safety. Never enables a global emergency mode and never pushes/fetches.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', minLength: 1, maxLength: 200, description: 'Caller-stable idempotency identity. Reusing it with different input fails closed.' },
        action: { type: 'string', enum: [...actionEnum] },
        reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Human/operator reason stored in the durable audit record.' },
        actorLabel: { type: 'string', minLength: 1, maxLength: 100 },
        projectId: { type: 'string', minLength: 1 },
        taskId: { type: 'string', minLength: 1 },
        workspaceId: { type: 'string' },
        executionSessionId: { type: 'string' },
        ownershipEpochId: { type: 'string' },
        expectedCandidateId: { type: 'string' },
        expectedOwnedFingerprint: { type: 'string' },
        expectedCommit: { type: 'string' },
        replacementSessionId: { type: 'string' },
        replacement: {
          type: 'object',
          properties: {
            taskId: { type: 'string' },
            executionSessionId: { type: 'string' },
            workspaceId: { type: 'string' },
            commit: { type: 'string' },
          },
        },
        noReplacement: { type: 'boolean' },
        message: { type: 'string', maxLength: 500 },
        finalizationOperationId: { type: 'string' },
        destructiveAck: { type: 'boolean', description: 'Required true only for discard-wip. Generic emergency intent is not destructive authorization.' },
        checks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              command: { type: 'string' },
              status: { type: 'string', enum: ['passed', 'failed', 'not-run'] },
              scope: { type: 'string', enum: ['targeted', 'broad', 'full'] },
              repoRevision: { type: 'string' },
              summary: { type: 'string' },
              output: { type: 'string' },
              recordedAt: { type: 'string' },
            },
            required: ['command', 'status'],
          },
        },
      },
      required: ['operationId', 'action', 'reason', 'actorLabel', 'projectId', 'taskId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/lifecycle/break-glass', body: args }),
  },
  {
    name: 'cleanup_orphan_executions',
    description: 'Dry-run or apply a bounded operator-authorized cleanup of active execution sessions proven orphaned from task claims. Apply reclassifies transactionally, cancels only uniquely bound claimless sessions with no pending operation, preserves task/workspace/Git state, records audit evidence, and replays one stable operationId without sweeping later batches.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', minLength: 1 },
        operationId: { type: 'string', minLength: 1, maxLength: 200, description: 'Stable idempotency identity for apply mode.' },
        mode: { type: 'string', enum: ['dry-run', 'apply'] },
        actorLabel: { type: 'string', minLength: 1, maxLength: 100 },
        reason: { type: 'string', minLength: 1, maxLength: 500, description: 'Human/operator reason persisted with cleanup evidence.' },
        limit: { type: 'number', minimum: 1, maximum: 100, description: 'Maximum active executions classified in this bounded operation. Defaults to 100.' },
      },
      required: ['projectId', 'operationId', 'mode', 'actorLabel', 'reason'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/lifecycle/orphan-executions/cleanup', body: args }),
  },
  {
    name: 'get_break_glass_operations',
    description: 'Read bounded durable break-glass lifecycle audit records. Read-only; does not advance lifecycle state.',
    inputSchema: {
      type: 'object',
      properties: {
        operationId: { type: 'string', description: 'Exact operation id. When present, returns one operation.' },
        projectId: { type: 'string' },
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['active', 'completed', 'rejected', 'partial'] },
        limit: { type: 'number', minimum: 1, maximum: 100 },
      },
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'GET', path: withQuery('/api/lifecycle/break-glass', args) }),
  },
];
