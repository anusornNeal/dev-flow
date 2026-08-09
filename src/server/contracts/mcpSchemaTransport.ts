type JsonSchema = Record<string, any>;

function isRecord(value: unknown): value is JsonSchema {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const transportInputSchemaCache = new WeakMap<JsonSchema, JsonSchema>();

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
