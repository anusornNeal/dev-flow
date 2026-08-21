import path from 'node:path';
import { recordRepoChanges } from './repoChangeJournalService';
import { publishServerEvent } from './serverEventService.js';

export type RepoCacheDependency =
  | 'repo-content'
  | 'repo-revision'
  | 'project-rules'
  | 'skills'
  | 'atlas-source'
  | 'atlas-authored';

export type RepoCacheInvalidationContext = {
  paths?: string[];
  uncertain?: boolean;
  dependencies?: RepoCacheDependency[];
  cause?: string;
  scope?: string;
};

type RepoCacheInvalidator = (root?: string, context?: RepoCacheInvalidationContext) => number | void;
type RepoCacheInvalidatorOptions = { dependencies?: RepoCacheDependency[] };
type RegisteredInvalidator = { invalidator: RepoCacheInvalidator; dependencies: RepoCacheDependency[] };

type CacheDomainMetrics = {
  hits: number;
  misses: number;
  invalidations: number;
  lastInvalidationReason?: string;
  lastInvalidatedAt?: string;
};

const DEFAULT_DOMAIN_DEPENDENCIES: Record<string, RepoCacheDependency[]> = {
  'local-file-search': ['repo-content', 'project-rules'],
  'git-remote-evidence': ['repo-revision'],
  'repo-inspection-index': ['repo-content', 'repo-revision', 'project-rules'],
  'repo-context-bundle': ['repo-content', 'repo-revision', 'project-rules'],
  'context-handles': ['repo-content', 'repo-revision', 'project-rules'],
  'verification-results': ['project-rules'],
  'project-atlas': ['atlas-source', 'atlas-authored'],
  skills: ['skills'],
};

const invalidators = new Map<string, RegisteredInvalidator>();
const dependencyGenerations = new Map<string, number>();
const broadRepoContentGenerations = new Map<string, number>();
const domainMetrics = new Map<string, CacheDomainMetrics>();

export type RepoCacheInvalidationResult = {
  root?: string;
  reason?: string;
  dependencies: RepoCacheDependency[];
  invalidated: Array<{ name: string; count: number }>;
  total: number;
  invalidatedAt: string;
  changeSequence?: number;
  lineageToken: string;
};

function normalizeDependencies(values: RepoCacheDependency[] = []) {
  return Array.from(new Set(values)).sort() as RepoCacheDependency[];
}

function normalizePaths(values: string[] = []) {
  return Array.from(new Set(values.map((entry) => String(entry || '').trim().replace(/\\/g, '/')).filter(Boolean))).sort();
}

function scopeKey(root?: string, scope?: string) {
  if (root) return `root:${path.resolve(root)}`;
  if (scope) return `scope:${scope.trim()}`;
  return 'global';
}

function generationKey(scope: string, dependency: RepoCacheDependency) {
  return `${scope}::${dependency}`;
}

type RepoCacheLineageOptions = { repoContentMode?: 'all' | 'broad-only' };

function generationFrom(store: Map<string, number>, root: string | undefined, dependency: RepoCacheDependency, scope?: string) {
  const globalGeneration = store.get(generationKey('global', dependency)) || 0;
  const selectedScope = scopeKey(root, scope);
  if (selectedScope === 'global') return globalGeneration;
  return globalGeneration + (store.get(generationKey(selectedScope, dependency)) || 0);
}

function dependencyGeneration(root: string | undefined, dependency: RepoCacheDependency, scope?: string, options: RepoCacheLineageOptions = {}) {
  const store = dependency === 'repo-content' && options.repoContentMode === 'broad-only'
    ? broadRepoContentGenerations
    : dependencyGenerations;
  return generationFrom(store, root, dependency, scope);
}

function bumpGeneration(store: Map<string, number>, root: string | undefined, dependency: RepoCacheDependency, scope?: string) {
  const selectedScope = scopeKey(root, scope);
  const key = generationKey(selectedScope, dependency);
  store.set(key, (store.get(key) || 0) + 1);
}

function bumpDependencyGeneration(root: string | undefined, dependency: RepoCacheDependency, scope?: string) {
  bumpGeneration(dependencyGenerations, root, dependency, scope);
}

function metricsFor(name: string) {
  const existing = domainMetrics.get(name);
  if (existing) return existing;
  const created: CacheDomainMetrics = { hits: 0, misses: 0, invalidations: 0 };
  domainMetrics.set(name, created);
  return created;
}

export function getRepoCacheLineage(root: string | undefined, dependencies: RepoCacheDependency[], scope?: string, options: RepoCacheLineageOptions = {}) {
  const normalized = normalizeDependencies(dependencies);
  const generations = Object.fromEntries(normalized.map((dependency) => [dependency, dependencyGeneration(root, dependency, scope, options)])) as Record<RepoCacheDependency, number>;
  const token = normalized.map((dependency) => `${dependency}:${generations[dependency]}`).join('|');
  return { scope: scopeKey(root, scope), generations, token };
}

export function registerRepoCacheInvalidator(name: string, invalidator: RepoCacheInvalidator, options: RepoCacheInvalidatorOptions = {}) {
  const dependencies = normalizeDependencies(options.dependencies?.length
    ? options.dependencies
    : DEFAULT_DOMAIN_DEPENDENCIES[name] || ['repo-content', 'repo-revision', 'project-rules']);
  invalidators.set(name, { invalidator, dependencies });
  metricsFor(name);
}

export function recordRepoCacheAccess(name: string, hit: boolean, _root?: string) {
  const metrics = metricsFor(name);
  if (hit) metrics.hits += 1;
  else metrics.misses += 1;
}

export function getRepoCacheDiagnostics(input: { root?: string; scope?: string; domains?: string[] } = {}) {
  const selected = input.domains?.length ? new Set(input.domains) : null;
  const domains = Array.from(invalidators.entries())
    .filter(([name]) => !selected || selected.has(name))
    .map(([name, registration]) => {
      const metrics = metricsFor(name);
      return {
        name,
        dependencies: registration.dependencies,
        hits: metrics.hits,
        misses: metrics.misses,
        hitRate: metrics.hits + metrics.misses > 0
          ? Math.round((metrics.hits / (metrics.hits + metrics.misses)) * 10_000) / 10_000
          : 0,
        invalidations: metrics.invalidations,
        lastInvalidationReason: metrics.lastInvalidationReason,
        lastInvalidatedAt: metrics.lastInvalidatedAt,
        lineageToken: getRepoCacheLineage(input.root, registration.dependencies, input.scope).token,
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
  return { domains };
}

export function invalidateRepoCacheDependencies(input: {
  root?: string;
  scope?: string;
  reason?: string;
  dependencies: RepoCacheDependency[];
  paths?: string[];
  uncertain?: boolean;
}): RepoCacheInvalidationResult {
  const dependencies = normalizeDependencies(input.dependencies);
  const normalizedPaths = normalizePaths(input.paths);
  const invalidatedAt = new Date().toISOString();
  const exactPathRepoContentChange = Boolean(input.root)
    && normalizedPaths.length > 0
    && input.uncertain !== true
    && dependencies.includes('repo-content')
    && !dependencies.includes('project-rules')
    && !dependencies.includes('repo-revision');
  for (const dependency of dependencies) bumpDependencyGeneration(input.root, dependency, input.scope);
  if (dependencies.includes('repo-content') && !exactPathRepoContentChange) {
    bumpGeneration(broadRepoContentGenerations, input.root, 'repo-content', input.scope);
  }

  const journalEvent = input.root && normalizedPaths.length > 0
    ? recordRepoChanges(input.root, normalizedPaths, input.reason)
    : undefined;
  const context: RepoCacheInvalidationContext = {
    paths: normalizedPaths,
    uncertain: input.uncertain,
    dependencies,
    cause: input.reason,
    scope: input.scope,
  };
  const invalidated = Array.from(invalidators.entries())
    .filter(([, registration]) => registration.dependencies.some((dependency) => dependencies.includes(dependency)))
    .map(([name, registration]) => {
      const count = Number(registration.invalidator(input.root, context) || 0);
      const metrics = metricsFor(name);
      metrics.invalidations += 1;
      metrics.lastInvalidationReason = input.reason;
      metrics.lastInvalidatedAt = invalidatedAt;
      return { name, count };
    });

  const atlasProjectId = input.scope?.startsWith('atlas:') ? input.scope.slice('atlas:'.length) : undefined;
  publishServerEvent('cache.invalidated', {
    projectId: atlasProjectId,
    reason: input.reason || dependencies.join(','),
  });

  return {
    root: input.root,
    reason: input.reason,
    dependencies,
    invalidated,
    total: invalidated.reduce((sum, entry) => sum + entry.count, 0),
    invalidatedAt,
    changeSequence: journalEvent?.sequence,
    lineageToken: getRepoCacheLineage(input.root, dependencies, input.scope).token,
  };
}

function inferLegacyDependencies(reason: string | undefined, context: RepoCacheInvalidationContext, normalizedPaths: string[]) {
  if (context.dependencies?.length) return normalizeDependencies(context.dependencies);
  const normalizedReason = String(reason || '').toLowerCase();
  const dependencies = new Set<RepoCacheDependency>();

  if (context.uncertain) {
    dependencies.add('repo-content');
    dependencies.add('repo-revision');
    dependencies.add('project-rules');
  }
  if (normalizedPaths.some((entry) => /(?:^|\/)config\/project-rules\.json$/i.test(entry) || /(?:^|\/)project-rules\.json$/i.test(entry))) {
    dependencies.add('project-rules');
    dependencies.add('repo-content');
  } else if (normalizedPaths.length > 0) {
    dependencies.add('repo-content');
  }

  if (normalizedReason.includes('ensuregitbranch')) {
    dependencies.add('repo-content');
    dependencies.add('repo-revision');
  } else if (normalizedReason.includes('commitgitchanges') || normalizedReason.includes('pushgitbranch')) {
    dependencies.add('repo-revision');
  }

  if (dependencies.size === 0) {
    dependencies.add('repo-content');
    dependencies.add('repo-revision');
    dependencies.add('project-rules');
  }
  return normalizeDependencies(Array.from(dependencies));
}

export function invalidateRepoReadCaches(root?: string, reason?: string, context: RepoCacheInvalidationContext = {}): RepoCacheInvalidationResult {
  const normalizedPaths = normalizePaths(context.paths);
  return invalidateRepoCacheDependencies({
    root,
    scope: context.scope,
    reason,
    dependencies: inferLegacyDependencies(reason, context, normalizedPaths),
    paths: normalizedPaths,
    uncertain: context.uncertain,
  });
}

export function listRepoCacheInvalidators() {
  return Array.from(invalidators.keys()).sort();
}
