import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

const coordinator = await import('../../src/server/services/repoCacheInvalidationService.js');

const root = path.resolve('cache-coordinator-fixture');

function requireFn(name: string) {
  const value = (coordinator as any)[name];
  assert.equal(typeof value, 'function', `${name} must be exported`);
  return value as (...args: any[]) => any;
}

test('coordinator invalidates only cache domains whose dependencies intersect the event', () => {
  const register = coordinator.registerRepoCacheInvalidator;
  const invalidate = requireFn('invalidateRepoCacheDependencies');
  const calls: string[] = [];
  const suffix = Date.now().toString(36);

  register(`test-source-${suffix}`, () => { calls.push('source'); return 1; }, { dependencies: ['repo-content'] } as any);
  register(`test-rules-${suffix}`, () => { calls.push('rules'); return 1; }, { dependencies: ['project-rules'] } as any);
  register(`test-skills-${suffix}`, () => { calls.push('skills'); return 1; }, { dependencies: ['skills'] } as any);
  register(`test-atlas-authored-${suffix}`, () => { calls.push('atlas-authored'); return 1; }, { dependencies: ['atlas-authored'] } as any);

  const result = invalidate({
    root,
    reason: 'source-write',
    dependencies: ['repo-content'],
    paths: ['src/App.ts'],
  });

  assert.deepEqual(calls, ['source']);
  assert.ok(result.invalidated.some((entry: any) => entry.name === `test-source-${suffix}`));
  assert.equal(result.invalidated.some((entry: any) => entry.name === `test-rules-${suffix}`), false);
  assert.deepEqual(result.dependencies, ['repo-content']);
});

test('invalidation matrix routes source, rules, skills, branch/revision, and Atlas events to exact dependency domains', () => {
  const suffix = Date.now().toString(36);
  const prefix = `matrix-${suffix}-`;
  const dependencies = ['repo-content', 'repo-revision', 'project-rules', 'skills', 'atlas-source', 'atlas-authored'] as const;
  for (const dependency of dependencies) {
    coordinator.registerRepoCacheInvalidator(`${prefix}${dependency}`, () => 1, { dependencies: [dependency] } as any);
  }

  const cases = [
    {
      name: 'source write',
      run: () => coordinator.invalidateRepoReadCaches(root, 'writeLocalFile', { paths: ['src/value.ts'] }),
      expected: ['repo-content'],
    },
    {
      name: 'project rules write',
      run: () => coordinator.invalidateRepoReadCaches(root, 'writeLocalFile', { paths: ['config/project-rules.json'] }),
      expected: ['project-rules', 'repo-content'],
    },
    {
      name: 'branch change',
      run: () => coordinator.invalidateRepoReadCaches(root, 'ensureGitBranch'),
      expected: ['repo-content', 'repo-revision'],
    },
    {
      name: 'revision change',
      run: () => coordinator.invalidateRepoReadCaches(root, 'commitGitChanges'),
      expected: ['repo-revision'],
    },
    {
      name: 'skill write',
      run: () => coordinator.invalidateRepoCacheDependencies({ reason: 'updateSkill', dependencies: ['skills'] }),
      expected: ['skills'],
    },
    {
      name: 'Atlas source drift',
      run: () => coordinator.invalidateRepoCacheDependencies({ scope: 'atlas:matrix', reason: 'repo-source-drift', dependencies: ['atlas-source'] }),
      expected: ['atlas-source'],
    },
    {
      name: 'Atlas authored update',
      run: () => coordinator.invalidateRepoCacheDependencies({ scope: 'atlas:matrix', reason: 'atlas-authored-update', dependencies: ['atlas-authored'] }),
      expected: ['atlas-authored'],
    },
  ];

  for (const entry of cases) {
    const result = entry.run();
    const routed = result.invalidated
      .map((item: any) => item.name)
      .filter((name: string) => name.startsWith(prefix))
      .map((name: string) => name.slice(prefix.length))
      .sort();
    assert.deepEqual(routed, [...entry.expected].sort(), entry.name);
  }
});

test('dependency lineage changes narrowly and preserves unrelated generations', () => {
  const invalidate = requireFn('invalidateRepoCacheDependencies');
  const lineage = requireFn('getRepoCacheLineage');

  const before = lineage(root, ['repo-content', 'project-rules', 'skills']);
  invalidate({ root, reason: 'source-write', dependencies: ['repo-content'] });
  const afterSource = lineage(root, ['repo-content', 'project-rules', 'skills']);

  assert.notEqual(afterSource.token, before.token);
  assert.ok(afterSource.generations['repo-content'] > before.generations['repo-content']);
  assert.equal(afterSource.generations['project-rules'], before.generations['project-rules']);
  assert.equal(afterSource.generations.skills, before.generations.skills);

  invalidate({ reason: 'skill-write', dependencies: ['skills'] });
  const afterSkill = lineage(root, ['repo-content', 'project-rules', 'skills']);
  assert.equal(afterSkill.generations['repo-content'], afterSource.generations['repo-content']);
  assert.equal(afterSkill.generations['project-rules'], afterSource.generations['project-rules']);
  assert.ok(afterSkill.generations.skills > afterSource.generations.skills);
});

test('path-aware repo-content lineage ignores exact paths but advances on broad or uncertain invalidation', () => {
  const invalidate = requireFn('invalidateRepoCacheDependencies');
  const lineage = requireFn('getRepoCacheLineage');
  const options = { repoContentMode: 'broad-only' };

  const beforeAll = lineage(root, ['repo-content']);
  const beforeBroad = lineage(root, ['repo-content'], undefined, options);

  invalidate({ root, reason: 'exact-write', dependencies: ['repo-content'], paths: ['src/value.ts'] });
  const afterExactAll = lineage(root, ['repo-content']);
  const afterExactBroad = lineage(root, ['repo-content'], undefined, options);
  assert.ok(afterExactAll.generations['repo-content'] > beforeAll.generations['repo-content']);
  assert.equal(afterExactBroad.generations['repo-content'], beforeBroad.generations['repo-content']);

  invalidate({ root, reason: 'uncertain-write', dependencies: ['repo-content'], paths: ['src/other.ts'], uncertain: true });
  const afterUncertainBroad = lineage(root, ['repo-content'], undefined, options);
  assert.ok(afterUncertainBroad.generations['repo-content'] > afterExactBroad.generations['repo-content']);

  invalidate({ root, reason: 'broad-write', dependencies: ['repo-content'] });
  const afterBroad = lineage(root, ['repo-content'], undefined, options);
  assert.ok(afterBroad.generations['repo-content'] > afterUncertainBroad.generations['repo-content']);
});

test('compact diagnostics track hit/miss and the latest invalidation reason per domain', () => {
  const recordAccess = requireFn('recordRepoCacheAccess');
  const diagnostics = requireFn('getRepoCacheDiagnostics');
  const invalidate = requireFn('invalidateRepoCacheDependencies');
  const suffix = Date.now().toString(36);
  const domain = `test-metrics-${suffix}`;

  coordinator.registerRepoCacheInvalidator(domain, () => 0, { dependencies: ['repo-content'] } as any);
  recordAccess(domain, true, root);
  recordAccess(domain, false, root);
  invalidate({ root, reason: 'writeLocalFile', dependencies: ['repo-content'], paths: ['src/value.ts'] });

  const result = diagnostics({ root, domains: [domain] });
  assert.equal(result.domains.length, 1);
  assert.equal(result.domains[0].name, domain);
  assert.equal(result.domains[0].hits, 1);
  assert.equal(result.domains[0].misses, 1);
  assert.equal(result.domains[0].hitRate, 0.5);
  assert.equal(result.domains[0].invalidations, 1);
  assert.equal(result.domains[0].lastInvalidationReason, 'writeLocalFile');
  assert.equal(typeof result.domains[0].lastInvalidatedAt, 'string');
  assert.ok(result.domains[0].lineageToken);
});

test('legacy invalidation maps source writes, project-rules writes, and git changes to precise dependencies', () => {
  const source = coordinator.invalidateRepoReadCaches(root, 'writeLocalFile', { paths: ['src/value.ts'] });
  assert.deepEqual(source.dependencies, ['repo-content']);

  const rules = coordinator.invalidateRepoReadCaches(root, 'writeLocalFile', { paths: ['config/project-rules.json'] });
  assert.deepEqual(rules.dependencies, ['project-rules', 'repo-content']);

  const commit = coordinator.invalidateRepoReadCaches(root, 'commitGitChanges');
  assert.deepEqual(commit.dependencies, ['repo-revision']);

  const branch = coordinator.invalidateRepoReadCaches(root, 'ensureGitBranch');
  assert.deepEqual(branch.dependencies, ['repo-content', 'repo-revision']);
});

test('Atlas source drift and authored updates use independent dependency lineage', () => {
  const invalidate = requireFn('invalidateRepoCacheDependencies');
  const lineage = requireFn('getRepoCacheLineage');
  const scope = 'atlas:project-123';

  const before = lineage(undefined, ['atlas-source', 'atlas-authored'], scope);
  invalidate({ scope, reason: 'repo-source-drift', dependencies: ['atlas-source'] });
  const source = lineage(undefined, ['atlas-source', 'atlas-authored'], scope);
  assert.ok(source.generations['atlas-source'] > before.generations['atlas-source']);
  assert.equal(source.generations['atlas-authored'], before.generations['atlas-authored']);

  invalidate({ scope, reason: 'atlas-authored-update', dependencies: ['atlas-authored'] });
  const authored = lineage(undefined, ['atlas-source', 'atlas-authored'], scope);
  assert.equal(authored.generations['atlas-source'], source.generations['atlas-source']);
  assert.ok(authored.generations['atlas-authored'] > source.generations['atlas-authored']);
});
