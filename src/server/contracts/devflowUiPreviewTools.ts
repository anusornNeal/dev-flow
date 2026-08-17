import { encodePathSegment, withQuery, type DevFlowToolDefinition } from './devflowContractCore.js';

const previewScreenSchema = {
  type: 'object',
  properties: {
    screenId: { type: 'string', description: 'Stable URL-safe opaque screen id.' },
    name: { type: 'string', description: 'Non-empty human-readable screen name.' },
    html: { type: 'string' },
    css: { type: 'string' },
    js: { type: 'string' },
    spec: { type: 'object', description: 'Structured UiSpecV1 with schemaVersion=1 and summary.screen.' },
  },
  required: ['screenId', 'name', 'html', 'css', 'js', 'spec'],
  additionalProperties: false,
};

const viewportSchema = {
  type: 'object',
  properties: {
    width: { type: 'number' },
    height: { type: 'number' },
    deviceScaleFactor: { type: 'number' },
  },
  additionalProperties: false,
};

const previewSourceProperties = {
  title: { type: ['string', 'null'] },
  html: { type: 'string' },
  css: { type: ['string', 'null'] },
  js: { type: ['string', 'null'] },
  spec: { type: 'object', description: 'Structured UiSpecV1 with schemaVersion=1 and summary.screen.' },
  screens: {
    type: 'array',
    minItems: 1,
    items: previewScreenSchema,
    description: 'Canonical ordered workspace screen set. Do not mix with legacy html/css/js/spec fields.',
  },
  defaultScreenId: { type: 'string', description: 'Canonical workspace default screen. Create defaults to the first screen when omitted.' },
  viewport: viewportSchema,
};

export const uiPreviewToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'create_ui_preview',
    description: 'Create one DevFlow-owned immutable PC/local UI preview workspace. Legacy single-screen input remains supported; canonical screens input creates one workspace revision.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task binding. A preview bound to one task cannot later bind to another.' },
        ...previewSourceProperties,
        idempotencyKey: { type: 'string', description: 'Optional durable operation-scoped idempotency key for safe retries.' },
      },
      oneOf: [
        { required: ['screens'], not: { anyOf: [{ required: ['html'] }, { required: ['css'] }, { required: ['js'] }, { required: ['spec'] }] } },
        { required: ['html', 'spec'], not: { required: ['screens'] } },
      ],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/ui-previews', body: args }),
  },
  {
    name: 'update_ui_preview',
    description: 'Append an immutable UI preview workspace revision. Canonical screens input replaces the complete ordered screen set; no per-screen mutation API exists. expectedRevision provides optimistic concurrency and idempotencyKey makes retries durable.',
    inputSchema: {
      type: 'object',
      properties: {
        previewId: { type: 'string' },
        expectedRevision: { type: 'number' },
        ...previewSourceProperties,
        idempotencyKey: { type: 'string', description: 'Optional durable operation-scoped idempotency key for safe retries.' },
      },
      required: ['previewId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: ({ previewId, ...body }) => ({
      method: 'PUT',
      path: `/api/ui-previews/${encodePathSegment(String(previewId))}`,
      body,
    }),
  },
  {
    name: 'get_ui_preview',
    description: 'Read bounded UI preview metadata by default. Set mode=source explicitly to read exact source for one selected immutable workspace revision.',
    inputSchema: {
      type: 'object',
      properties: {
        previewId: { type: 'string' },
        revision: { type: 'number' },
        mode: { type: 'string', enum: ['summary', 'source'], description: 'Defaults to summary; raw source is returned only for source mode.' },
      },
      required: ['previewId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: ({ previewId, revision, mode }) => ({
      method: 'GET',
      path: withQuery(`/api/ui-previews/${encodePathSegment(String(previewId))}`, { revision, mode: mode || 'summary' }),
    }),
  },
  {
    name: 'attach_ui_preview_to_task',
    description: 'Capture and freeze one immutable UI preview workspace revision as Task UI Design evidence, optionally selecting one primary screen.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        previewId: { type: 'string' },
        revision: { type: 'number', description: 'Optional immutable revision. Omit to resolve latest exactly once at attach start.' },
        primaryScreenId: { type: 'string', description: 'Optional screen to freeze as primary evidence. Omit to use the workspace default screen.' },
        idempotencyKey: { type: 'string', description: 'Optional durable operation-scoped idempotency key; delayed retries replay the original logical evidence.' },
      },
      required: ['taskId', 'previewId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, previewId, revision, primaryScreenId, idempotencyKey }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/ui-evidence`,
      body: {
        previewId,
        ...(revision === undefined ? {} : { revision }),
        ...(primaryScreenId === undefined ? {} : { primaryScreenId }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      },
    }),
  },
];
