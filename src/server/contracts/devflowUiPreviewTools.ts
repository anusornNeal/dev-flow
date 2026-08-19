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

const designExceptionCategorySchema = { type: 'string', enum: ['project-style', 'accessibility', 'interaction', 'destructive-safety', 'aesthetic-heuristic'] };

const designExceptionAuthoritySchema = {
  type: 'object',
  properties: {
    type: { type: 'string', enum: ['task-requirement', 'frozen-ui-design'] },
    authorityId: { type: 'string', maxLength: 240 },
    taskId: { type: 'string', maxLength: 240 },
    projectId: { type: 'string', maxLength: 240 },
    current: { type: 'boolean' },
    authorizedRuleIds: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 240 } },
    authorizedCategories: { type: 'array', maxItems: 16, items: designExceptionCategorySchema },
    evidenceId: { type: 'string', maxLength: 240 },
    frozenRevision: { type: 'number' },
  },
  required: ['type', 'authorityId', 'taskId', 'projectId', 'current', 'authorizedRuleIds', 'authorizedCategories'],
  additionalProperties: false,
};

const designExceptionRefSchema = {
  type: 'object',
  properties: {
    exceptionId: { type: 'string', maxLength: 240 },
    ruleIds: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 240 } },
    categories: { type: 'array', maxItems: 16, items: designExceptionCategorySchema },
    authority: designExceptionAuthoritySchema,
  },
  required: ['exceptionId', 'ruleIds', 'categories'],
  additionalProperties: false,
};

const scopedPreviewProperties = {
  projectId: { type: 'string', description: 'Optional explicit project scope. When taskId is also supplied it must match the task project.' },
  expectedDesignContextHash: { type: 'string', minLength: 64, maxLength: 64, pattern: '^[0-9a-fA-F]{64}$', description: 'Required for scoped writes; use the current contextHash returned by get_ui_design_context.' },
  exceptionRefs: { type: 'array', maxItems: 16, items: designExceptionRefSchema, description: 'Optional bounded structured exception references. Free-form reasons are not enforcement authority.' },
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
    name: 'get_ui_design_context',
    description: 'Read bounded project UI/UX design context before authoring scoped preview HTML/CSS/JS. Task scope derives its project server-side; relevanceHint only influences evidence ranking and is never authoritative.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task scope. When supplied, DevFlow derives the authoritative project from the task.' },
        projectId: { type: 'string', description: 'Explicit project scope. When taskId is also supplied it must match the task project.' },
        relevanceHint: { type: 'string', maxLength: 300, description: 'Optional non-authoritative screen/flow relevance hint used only to rank nearby project evidence.' },
      },
      anyOf: [{ required: ['taskId'] }, { required: ['projectId'] }],
      additionalProperties: false,
    },
    outputSchema: { type: 'object' },
    lightweight: true,
    buildHttpRequest: ({ taskId, projectId, relevanceHint }) => ({
      method: 'GET',
      path: withQuery('/api/ui-preview-design-context', { taskId, projectId, relevanceHint }),
    }),
  },
  {
    name: 'create_ui_preview',
    description: 'Create one DevFlow-owned immutable PC/local UI preview workspace. Scoped task/project writes require expectedDesignContextHash from get_ui_design_context and are revalidated server-side before persistence; legacy unscoped input remains supported.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Optional task binding. A preview bound to one task cannot later bind to another.' },
        ...scopedPreviewProperties,
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
    description: 'Append an immutable UI preview workspace revision. Scoped updates must preserve immutable task/project scope and present current expectedDesignContextHash; canonical screens replace the complete ordered set. expectedRevision provides optimistic concurrency and idempotencyKey makes retries durable.',
    inputSchema: {
      type: 'object',
      properties: {
        previewId: { type: 'string' },
        expectedRevision: { type: 'number' },
        taskId: { type: 'string', description: 'Optional immutable task-scope assertion for a task-bound preview update.' },
        ...scopedPreviewProperties,
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
