import { recordRepoChanges } from './repoChangeJournalService';

export type RepoCacheInvalidationContext = {
  paths?: string[];
  uncertain?: boolean;
};

type RepoCacheInvalidator = (root?: string, context?: RepoCacheInvalidationContext) => number | void;

const invalidators = new Map<string, RepoCacheInvalidator>();

export type RepoCacheInvalidationResult = {
  root?: string;
  reason?: string;
  invalidated: Array<{ name: string; count: number }>;
  total: number;
  invalidatedAt: string;
  changeSequence?: number;
};

export function registerRepoCacheInvalidator(name: string, invalidator: RepoCacheInvalidator) {
  invalidators.set(name, invalidator);
}

export function invalidateRepoReadCaches(root?: string, reason?: string, context: RepoCacheInvalidationContext = {}): RepoCacheInvalidationResult {
  const normalizedPaths = Array.from(new Set((context.paths || []).map((entry) => String(entry || '').trim().replace(/\\/g, '/')).filter(Boolean))).sort();
  const journalEvent = root && normalizedPaths.length > 0 ? recordRepoChanges(root, normalizedPaths, reason) : undefined;
  const normalizedContext = { ...context, paths: normalizedPaths };
  const invalidated = Array.from(invalidators.entries()).map(([name, invalidator]) => {
    const count = Number(invalidator(root, normalizedContext) || 0);
    return { name, count };
  });
  return {
    root,
    reason,
    invalidated,
    total: invalidated.reduce((sum, entry) => sum + entry.count, 0),
    invalidatedAt: new Date().toISOString(),
    changeSequence: journalEvent?.sequence,
  };
}

export function listRepoCacheInvalidators() {
  return Array.from(invalidators.keys()).sort();
}
