import { encodePathSegment, stripToolOnlyArgs, type DevFlowToolDefinition } from './devflowContractCore';

const executionSessionIdProperty = {
  executionSessionId: { type: 'string', description: 'Logical DevFlow execution-session id such as exec-....' },
};

const stringListProperty = (description: string) => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

export const executionToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'resume_execution',
    description: 'Resume one logical execution session with compact progress, handoff, verification, and freshness state. Revalidates revision-bound evidence against the current bound workspace or project root when available.',
    inputSchema: {
      type: 'object',
      properties: {
        ...executionSessionIdProperty,
        workspaceId: { type: 'string', description: 'Optional opaque managed workspace id expected by the receiving execution.' },
        receivingAgent: { type: 'string', description: 'Optional receiving agent/provider label used only for handoff-target warnings.' },
      },
      required: ['executionSessionId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: `/api/execution-sessions/${encodePathSegment(String(args.executionSessionId))}/resume`,
      body: stripToolOnlyArgs(args, ['executionSessionId']),
    }),
  },
  {
    name: 'handoff_execution',
    description: 'Persist one compact cross-agent handoff snapshot for an active execution session. Carries decisions, pending work, dependencies, risks, verification state, and revision-bound evidence references without copying source bodies.',
    inputSchema: {
      type: 'object',
      properties: {
        ...executionSessionIdProperty,
        fromAgent: { type: 'string' },
        toAgent: { type: 'string' },
        fromProvider: { type: 'string' },
        toProvider: { type: 'string' },
        lastCompletedStage: { type: 'string' },
        completedWork: stringListProperty('Explicit completed work to merge with task checklist progress.'),
        pendingNextWork: stringListProperty('Explicit next work. When omitted, pending task checklist items are used.'),
        decisions: stringListProperty('Compact implementation or workflow decisions that should survive the handoff.'),
        dependencies: stringListProperty('Dependencies the receiving execution should know about.'),
        risks: stringListProperty('Known risks or stale-context concerns for the receiving execution.'),
        note: { type: 'string', description: 'Optional compact free-form handoff note.' },
      },
      required: ['executionSessionId'],
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({
      method: 'POST',
      path: `/api/execution-sessions/${encodePathSegment(String(args.executionSessionId))}/handoff`,
      body: stripToolOnlyArgs(args, ['executionSessionId']),
    }),
  },
];
