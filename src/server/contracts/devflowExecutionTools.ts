import { encodePathSegment, withQuery, type DevFlowToolDefinition } from './devflowContractCore';

const executionSessionIdProperty = {
  executionSessionId: { type: 'string', description: 'Logical DevFlow execution-session id such as exec-....' },
};

export const executionToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'continue_task_execution_tail',
    description: 'Supply the missing reasoning-agent commit intent for one exact authoritative GREEN board-loop verification and start or reuse the existing durable execution tail. This continuation never reruns the source verification merely to attach commit intent.',
    inputSchema: {
      type: 'object',
      properties: {
        ...executionSessionIdProperty,
        triggerJobId: { type: 'string', description: 'Exact succeeded run_project_command job id reported by get_execution_continuation.' },
        workspaceId: { type: 'string', description: 'Optional exact managed workspace assertion from the continuation result.' },
        commitMessage: { type: 'string', minLength: 3, maxLength: 240, description: 'Conventional commit intent chosen by the reasoning agent. DevFlow never invents semantic commit text.' },
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
