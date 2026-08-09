import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkDecomposition } from '../../src/server/services/workDecompositionService.js';

const evidence = (paths: Array<{ path: string; symbols?: string[]; imports?: string[]; score?: number }>) => ({
  repoRevision: 'rev-fixture',
  matches: paths.map((item) => ({ extension: '.ts', symbols: [], imports: [], score: 4, ...item })),
});

test('buildWorkDecomposition keeps a one-file change runnable and evidence-backed', () => {
  const result = buildWorkDecomposition({
    title: 'Fix task title normalization',
    description: 'Update normalizeTaskTitle and add regression coverage.',
    targetFiles: ['src/server/services/taskService.ts'],
    verification: 'Run task service tests.',
    repoEvidence: evidence([
      { path: 'src/server/services/taskService.ts', symbols: ['normalizeTaskTitle'], score: 8 },
      { path: 'tests/server/taskService.test.ts', symbols: [], score: 5 },
    ]),
  });

  assert.equal(result.nodes.length, 2);
  assert.deepEqual(result.runnableNow, ['backend']);
  assert.deepEqual(result.blocked.map((entry) => entry.nodeId), ['verification']);
  const implementation = result.nodes.find((node) => node.id === 'backend');
  assert.deepEqual(implementation?.targetFiles, ['src/server/services/taskService.ts']);
  assert.equal(implementation?.uncertainty, 'low');
  assert.ok(implementation?.evidence.some((item) => item.reason.includes('explicit target')));
  const verification = result.nodes.find((node) => node.id === 'verification');
  assert.deepEqual(verification?.dependsOn, ['backend']);
  assert.ok(verification?.targetFiles.includes('tests/server/taskService.test.ts'));
});

test('buildWorkDecomposition creates dependency edges for cross-layer contract work', () => {
  const result = buildWorkDecomposition({
    title: 'Add account status API and screen',
    description: 'Add API contract, repository persistence, React screen, and focused tests.',
    repoEvidence: evidence([
      { path: 'src/server/contracts/accountContract.ts', symbols: ['AccountStatus'], score: 9 },
      { path: 'src/server/services/accountService.ts', symbols: ['getAccountStatus'], imports: ['../contracts/accountContract'], score: 8 },
      { path: 'src/components/AccountStatusPanel.tsx', symbols: ['AccountStatusPanel'], score: 8 },
      { path: 'tests/server/accountService.test.ts', score: 6 },
    ]),
  });

  const ids = result.nodes.map((node) => node.id);
  assert.ok(ids.includes('contract'));
  assert.ok(ids.includes('backend'));
  assert.ok(ids.includes('frontend'));
  assert.ok(ids.includes('verification'));
  assert.ok(result.edges.some((edge) => edge.from === 'contract' && edge.to === 'backend' && edge.kind === 'prerequisite'));
  assert.ok(result.edges.some((edge) => edge.from === 'contract' && edge.to === 'frontend' && edge.kind === 'prerequisite'));
  assert.ok(result.edges.some((edge) => edge.to === 'verification' && edge.kind === 'verification'));
  assert.deepEqual(result.runnableNow, ['contract']);
});

test('buildWorkDecomposition serializes overlapping high-conflict scopes instead of claiming parallel safety', () => {
  const result = buildWorkDecomposition({
    title: 'Refactor shared task route and service behavior',
    description: 'Change route contract and service orchestration in shared task files.',
    repoEvidence: evidence([
      { path: 'src/server/routes/tasks.ts', symbols: ['registerTaskRoutes'], score: 9 },
      { path: 'src/server/services/taskService.ts', symbols: ['updateTask'], score: 9 },
      { path: 'src/server/services/taskSharedService.ts', symbols: ['updateTask'], score: 8 },
      { path: 'tests/server/taskRoutes.test.ts', score: 5 },
    ]),
  });

  assert.ok(result.nodes.some((node) => node.conflictRisk === 'high'));
  assert.ok(result.edges.some((edge) => edge.kind === 'conflict-serialization'));
  assert.equal(result.parallelGroups.some((group) => group.length > 1), false);
});

test('buildWorkDecomposition labels uncertain targets and blocks unsupported work', () => {
  const result = buildWorkDecomposition({
    title: 'Migrate billing ledger schema',
    description: 'Add migration and update consumers, but repository evidence has no billing files.',
    repoEvidence: evidence([]),
  });

  assert.equal(result.runnableNow.length, 0);
  assert.ok(result.blocked.length >= 1);
  assert.ok(result.nodes.every((node) => node.uncertainty !== 'low'));
  assert.ok(result.blocked.some((entry) => /evidence/i.test(entry.reason)));
});

test('buildWorkDecomposition makes migrations precede persistence consumers', () => {
  const result = buildWorkDecomposition({
    title: 'Migrate billing ledger schema and repository',
    description: 'Add schema migration, update repository consumer, and verify persistence.',
    repoEvidence: evidence([
      { path: 'src/db/migrations/018-ledger.sql', score: 9 },
      { path: 'src/server/repositories/ledgerRepository.ts', score: 8 },
      { path: 'tests/server/ledgerRepository.test.ts', score: 6 },
    ]),
  });

  assert.ok(result.nodes.some((node) => node.id === 'migration'));
  assert.ok(result.edges.some((edge) => edge.from === 'migration' && edge.to === 'backend' && edge.kind === 'prerequisite'));
  assert.deepEqual(result.runnableNow, ['migration']);
  assert.ok(result.blocked.some((entry) => entry.nodeId === 'backend' && /migration/i.test(entry.reason)));
});

test('buildWorkDecomposition exposes parallel-safe independent frontend and backend slices', () => {
  const result = buildWorkDecomposition({
    title: 'Add profile summary rendering and server formatter',
    description: 'Independent UI rendering and backend formatting can be verified separately.',
    repoEvidence: evidence([
      { path: 'src/components/ProfileSummary.tsx', score: 8 },
      { path: 'src/server/services/profileFormatter.ts', score: 8 },
      { path: 'tests/server/profileFormatter.test.ts', score: 6 },
    ]),
  });

  assert.deepEqual(result.runnableNow, ['backend', 'frontend']);
  assert.ok(result.parallelGroups.some((group) => group.join(',') === 'backend,frontend'));
  assert.equal(result.edges.some((edge) => edge.kind === 'conflict-serialization'), false);
});

test('buildWorkDecomposition emits valid graph references and deterministic output', () => {
  const input = {
    title: 'Update shared settings persistence',
    description: 'Change settings repository and API route with tests.',
    repoEvidence: evidence([
      { path: 'src/server/repositories/settingsRepository.ts', score: 8 },
      { path: 'src/server/routes/settings.ts', score: 8 },
      { path: 'tests/server/settingsRepository.test.ts', score: 6 },
    ]),
  };
  const first = buildWorkDecomposition(input);
  const second = buildWorkDecomposition(input);

  assert.deepEqual(second, first);
  const nodeIds = new Set(first.nodes.map((node) => node.id));
  assert.ok(first.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)));
  assert.ok(first.nodes.every((node) => node.verificationOwnership.length > 0));
});
