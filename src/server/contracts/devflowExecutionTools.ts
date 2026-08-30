import { encodePathSegment, withQuery, type DevFlowToolDefinition } from './devflowContractCore';

const executionSessionIdProperty = {
  executionSessionId: { type: 'string', description: 'Logical DevFlow execution-session id such as exec-....' },
};

export const executionToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'continue_task_execution_tail',
    description: 'Continue an authoritative GREEN execution tail with explicit commit intent; source verification is not rerun.',
    inputSchema: {
      type: 'object',
      properties: {
        ...executionSessionIdProperty,
        triggerJobId: { type: 'string' },
        workspaceId: { type: 'string' },
        commitMessage: { type: 'string', minLength: 3, maxLength: 240 },
        completedChecklistIds: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Attested completed checklist ids.' },
      },
      required: ['executionSessionId', 'triggerJobId', 'commitMessage'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: `/api/execution-sessions/${encodePathSegment(String(args.executionSessionId))}/continue-tail`,
      body: {
        triggerJobId: args.triggerJobId,
        workspaceId: args.workspaceId,
        commitMessage: args.commitMessage,
        ...(Array.isArray(args.completedChecklistIds) ? { completedChecklistIds: args.completedChecklistIds } : {}),
      },
    }),
  },
  {
    name: 'get_execution_continuation',
    description: 'Read the authoritative terminal/continuation truth for one existing execution session. Returns exact pending-job/finalization continuation when mechanical recovery is known and never starts replacement work.',
    inputSchema: {
      type: 'object',
      properties: {
        ...executionSessionIdProperty,
        workspaceId: { type: 'string', description: 'Optional opaque managed workspace id expected by the caller. A mismatch is reported as recovery-required and never creates a replacement execution.' },
        boardLoopRequested: { type: 'boolean', description: 'Marks that the caller is operating in board-loop scope. Task-terminal truth is still evaluated independently; project eligibility remains delegated to board selection.' },
      },
      required: ['executionSessionId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'GET',
      path: withQuery(`/api/execution-sessions/${encodePathSegment(String(args.executionSessionId))}/continuation`, {
        workspaceId: args.workspaceId,
        boardLoopRequested: args.boardLoopRequested,
      }),
    }),
  },
];
