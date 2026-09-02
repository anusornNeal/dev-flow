type JsonSchema = Record<string, any>;

function isRecord(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const transportInputSchemaCache = new WeakMap<JsonSchema, JsonSchema>();

const OMITTED_TRANSPORT_DESCRIPTIONS = new Set([
  'Project internal id.',
  'Repository URL.',
  'Task title.',
  'Task lane/status.',
  'Task priority.',
  'Git branch name.',
  'Relevant file paths.',
  'Checklist items.',
  'Assigned model.',
  'Assigned agent.',
  'Parent task id.',
  'Reasoning/context.',
  'Acceptance criteria.',
  'Verification steps.',
  'Repository context.',
  'Specification URL.',
  'Jira issue key.',
  'Source URL.',
  'Bug severity.',
  'Where the bug report came from.',
  'Observed wrong behavior.',
  'Expected behavior.',
  'Who created the bug thread.',
]);

const COMPACT_TRANSPORT_DESCRIPTIONS = new Map<string, string>([
  ['Project name when it is unique and safe to resolve.', 'Unique project name.'],
  ['Repository URL or shorthand.', 'Repo URL/shorthand.'],
  ['Absolute local project path.', 'Absolute project path.'],
  ['Opaque caller session id. When supplied with a project, DevFlow creates or reuses an isolated managed workspace internally.', 'Caller session id; creates/reuses isolated workspace.'],
  ['Opaque DevFlow workspace id for an isolated session. Callers must not derive or persist its filesystem path.', 'Opaque workspace id; never derive its path.'],
  ['Task internal id or displayId such as DVF-0120.', 'Task id/displayId.'],
  ['Mutation response density. Use summary or ack for faster ChatGPT tool calls.', 'Response density; prefer summary/ack.'],
  ['Marks this as an agent-owned mutation that may bypass normal task locks.', 'Agent-owned mutation; may bypass normal task locks.'],
  ['Stable client-provided key for safe retries. Reusing the key with a different request returns IDEMPOTENCY_CONFLICT.', 'Stable idempotency key; conflicting reuse fails.'],
]);

function trimTransportDescription(schema: JsonSchema) {
  const description = typeof schema.description === 'string' ? schema.description : null;
  if (!description) return;
  if (OMITTED_TRANSPORT_DESCRIPTIONS.has(description)) {
    delete schema.description;
    return;
  }
  const compact = COMPACT_TRANSPORT_DESCRIPTIONS.get(description);
  if (compact) schema.description = compact;
}

function deepFreezeSchemaValue<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreezeSchemaValue(entry);
    return Object.freeze(value) as T;
  }
  if (!isRecord(value)) return value;
  for (const entry of Object.values(value)) deepFreezeSchemaValue(entry);
  return Object.freeze(value) as T;
}

function mergeRequired(parentRequired: unknown, branchRequired: unknown) {
  const values = [
    ...(Array.isArray(parentRequired) ? parentRequired : []),
    ...(Array.isArray(branchRequired) ? branchRequired : []),
  ].filter((value): value is string => typeof value === 'string');
  return [...new Set(values)];
}

function normalizeSchemaValue(value: any): any {
  if (Array.isArray(value)) return value.map(normalizeSchemaValue);
  if (!isRecord(value)) return value;

  const normalized = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, normalizeSchemaValue(entry)]),
  ) as JsonSchema;
  trimTransportDescription(normalized);

  const properties = isRecord(normalized.properties) ? normalized.properties : null;
  const branches = Array.isArray(normalized.anyOf) ? normalized.anyOf : null;
  if (normalized.type !== 'object' || !properties || !branches) return normalized;

  const canMaterializeEveryBranch = branches.every(
    (branch) => isRecord(branch) && (branch.type === undefined || branch.type === 'object'),
  );
  if (!canMaterializeEveryBranch) return normalized;

  normalized.anyOf = branches.map((branch) => {
    const branchProperties = isRecord(branch.properties) ? branch.properties : {};
    const required = mergeRequired(normalized.required, branch.required);
    return {
      ...branch,
      type: branch.type || 'object',
      properties: {
        ...properties,
        ...branchProperties,
      },
      ...(required.length > 0 ? { required } : {}),
    };
  });
  delete normalized.properties;
  delete normalized.required;

  return normalized;
}

export function buildMcpTransportInputSchema(schema: JsonSchema): JsonSchema {
  const cached = transportInputSchemaCache.get(schema);
  if (cached) return cached;

  const normalized = deepFreezeSchemaValue(normalizeSchemaValue(schema));
  transportInputSchemaCache.set(schema, normalized);
  return normalized;
}
