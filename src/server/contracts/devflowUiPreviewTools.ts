import { encodePathSegment, withQuery, type DevFlowToolDefinition } from './devflowContractCore.js';

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
  viewport: viewportSchema,
};

export const uiPreviewToolDefinitions: DevFlowToolDefinition[] = [
  {
    name: 'create_ui_preview',
    description: 'Create one DevFlow-owned immutable PC/local UI preview resource. Returns bounded metadata and a local preview URL; raw source is not echoed.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task binding. A preview bound to one task cannot later bind to another.' },
        ...previewSourceProperties,
        idempotencyKey: { type: 'string', description: 'Optional durable operation-scoped idempotency key for safe retries.' },
      },
      required: ['html', 'spec'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: (args) => ({ method: 'POST', path: '/api/ui-previews', body: args }),
  },
  {
    name: 'update_ui_preview',
    description: 'Append an immutable UI preview revision using patch semantics. expectedRevision provides optimistic concurrency and idempotencyKey makes retries durable.',
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
    description: 'Read bounded UI preview metadata by default. Set mode=source explicitly to read exact HTML/CSS/JS/spec for one selected immutable revision.',
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
    description: 'Capture and freeze one immutable UI preview revision as Task UI Design evidence. Same-revision work collapses and the highest frozen revision wins for each task+preview pair.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string' },
        previewId: { type: 'string' },
        revision: { type: 'number', description: 'Optional immutable revision. Omit to resolve latest exactly once at attach start.' },
        idempotencyKey: { type: 'string', description: 'Optional durable operation-scoped idempotency key; delayed retries replay the original logical evidence.' },
      },
      required: ['taskId', 'previewId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    buildHttpRequest: ({ taskId, previewId, revision, idempotencyKey }) => ({
      method: 'POST',
      path: `/api/tasks/${encodePathSegment(String(taskId))}/ui-evidence`,
      body: { previewId, ...(revision === undefined ? {} : { revision }), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
    }),
  },
];
