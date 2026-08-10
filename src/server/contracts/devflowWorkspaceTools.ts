import { projectIdentifierProperties, type DevFlowToolDefinition } from './devflowContractCore';

export const workspaceToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'prepare_session_workspace',
    description: 'Create or reuse one isolated local Git worktree for an opaque caller session. DevFlow owns the physical path; callers should persist only workspaceId.',
    inputSchema: {
      type: 'object',
      properties: {
        ...projectIdentifierProperties,
        sessionId: { type: 'string', description: 'Opaque caller session id used to deterministically create/reuse an isolated workspace.' },
      },
      required: ['sessionId'],
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/prepare', body: args }),
  },
  {
    name: 'integrate_workspace',
    description: 'Rebase committed workspace work onto the latest recorded local base, then integrate with fast-forward only. Preserves individual commits by default, never pushes or fetches, and returns structured INTEGRATION_CONFLICT data without mutating the shared base on rebase conflicts.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integrate', body: args }),
  },
  {
    name: 'abort_workspace_integration',
    description: 'Abort a conflicted workspace rebase and restore the original source HEAD while leaving the shared base untouched and preserving source commits.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integration/abort', body: args }),
  },
  {
    name: 'retry_workspace_integration',
    description: 'Continue/finalize a deliberately resolved workspace rebase, then fast-forward the recorded local base. Never chooses conflict resolutions automatically.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/integration/retry', body: args }),
  },
  {
    name: 'cleanup_session_workspace',
    description: 'Remove a clean, inactive, integration-safe managed session worktree. Normal cleanup refuses dirty/active/integration-required workspaces.',
    inputSchema: { type: 'object', properties: { workspaceId: { type: 'string', description: 'Opaque DevFlow workspace id.' } }, required: ['workspaceId'] },
    outputSchema: { type: 'object' },
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/workspaces/cleanup', body: args }),
  },
];
