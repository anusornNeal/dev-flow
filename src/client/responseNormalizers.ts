function pickArrayFromKeys(record: Record<string, unknown>, keys: string[]): unknown[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function normalizeListResponse(data: unknown, keys: string[]): any[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const list = pickArrayFromKeys(data as Record<string, unknown>, keys);
    if (list) return list;
  }
  return [];
}

export function normalizeTaskListResponse(data: unknown): any[] {
  return normalizeListResponse(data, ['items', 'tasks']);
}

export function normalizeProjectListResponse(data: unknown): any[] {
  return normalizeListResponse(data, ['items', 'projects']);
}
