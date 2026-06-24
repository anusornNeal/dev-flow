type RepoCacheInvalidator = (root?: string) => number | void;

const invalidators = new Map<string, RepoCacheInvalidator>();

export type RepoCacheInvalidationResult = {
  root?: string;
  reason?: string;
  invalidated: Array<{ name: string; count: number }>;
  total: number;
  invalidatedAt: string;
};

export function registerRepoCacheInvalidator(name: string, invalidator: RepoCacheInvalidator) {
  invalidators.set(name, invalidator);
}

export function invalidateRepoReadCaches(root?: string, reason?: string): RepoCacheInvalidationResult {
  const invalidated = Array.from(invalidators.entries()).map(([name, invalidator]) => {
    const count = Number(invalidator(root) || 0);
    return { name, count };
  });
  return {
    root,
    reason,
    invalidated,
    total: invalidated.reduce((sum, entry) => sum + entry.count, 0),
    invalidatedAt: new Date().toISOString(),
  };
}

export function listRepoCacheInvalidators() {
  return Array.from(invalidators.keys()).sort();
}
