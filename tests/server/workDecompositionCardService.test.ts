import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDecompositionCardPlan } from '../../src/server/services/workDecompositionCardService.js';
import { buildWorkDecomposition } from '../../src/server/services/workDecompositionService.js';

const repoEvidence = {
  repoRevision: 'rev-cards',
  matches: [
    { path: 'src/server/contracts/accountContract.ts', symbols: ['AccountStatus'], score: 9 },
    { path: 'src/server/services/accountService.ts', symbols: ['getAccountStatus'], score: 8 },
    { path: 'src/components/AccountStatusPanel.tsx', symbols: ['AccountStatusPanel'], score: 8 },
    { path: 'tests/server/accountService.test.ts', symbols: [], score: 6 },
  ],
};

function crossLayerDag() {
  return buildWorkDecomposition({
    title: 'Add account status API and screen',
    description: 'Add contract, backend service, frontend panel, and focused tests.',
    repoEvidence,
  });
}

test('buildDecompositionCardPlan is inspect-only by default and preserves DAG dependencies', () => {
  const result = buildDecompositionCardPlan({
    projectId: 'project-1',
    parentTitle: 'Account status delivery',
    decomposition: crossLayerDag(),
  });

  assert.equal(result.mode, 'inspect');
  assert.equal(result.creationPayload, undefined);
  assert.equal(result.evaluation.ok, true);
  assert.equal(result.children.length, 3);
  assert.ok(result.parent.verification.includes('focused regression'));
  const backend = result.children.find((child) => child.decompositionNodeId === 'backend');
  assert.ok(backend);
  assert.ok(backend?.repoContext.includes('Prerequisites: contract'));
  assert.ok(backend?.checklist.some((item) => /prerequisite.*contract/i.test(item.text)));
  assert.deepEqual(backend?.prerequisiteTaskIds, ['contract']);
  assert.deepEqual(backend?.targetFiles, ['src/server/services/accountService.ts']);
  assert.equal(backend?.category, 'backend');
  const frontend = result.children.find((child) => child.decompositionNodeId === 'frontend');
  assert.equal(frontend?.category, 'frontend');
});

test('buildDecompositionCardPlan returns atomic task-set payload only when creation is requested and quality passes', () => {
  const result = buildDecompositionCardPlan({
    projectId: 'project-1',
    parentTitle: 'Account status delivery',
    createRequested: true,
    decomposition: crossLayerDag(),
  });

  assert.equal(result.mode, 'create-requested');
  assert.equal(result.evaluation.ok, true);
  assert.ok(result.creationPayload);
  assert.equal(result.creationPayload?.projectId, 'project-1');
  assert.equal(result.creationPayload?.children.length, 3);
  assert.ok(result.creationPayload?.children.every((child) => !('parentId' in child)));
  const contract = result.creationPayload?.children.find((child: any) => child.taskSetKey === 'contract') as any;
  const backend = result.creationPayload?.children.find((child: any) => child.taskSetKey === 'backend') as any;
  assert.ok(contract);
  assert.ok(backend);
  assert.deepEqual(backend.prerequisiteTaskIds, ['contract']);
});

test('buildDecompositionCardPlan preserves blocked decisions as prep cards instead of inventing targets', () => {
  const decomposition = buildWorkDecomposition({
    title: 'Migrate unknown billing schema',
    description: 'Need product decision and repo evidence before changing billing.',
    repoEvidence: { repoRevision: 'rev-empty', matches: [] },
  });
  const result = buildDecompositionCardPlan({
    projectId: 'project-1',
    parentTitle: 'Billing migration discovery',
    createRequested: true,
    decomposition,
  });

  assert.equal(result.children.length, 1);
  const child = result.children[0];
  assert.equal(child.decompositionNodeId, 'discovery');
  assert.deepEqual(child.targetFiles, []);
  assert.ok(child.tags.includes('decomposition-blocked'));
  assert.match(child.reasoning, /blocked/i);
  assert.ok(result.creationPayload);
});

test('buildDecompositionCardPlan blocks creation when sibling scope overlaps without a dependency explanation', () => {
  const decomposition: any = {
    schemaVersion: 1,
    repoRevision: 'rev-overlap',
    nodes: [
      {
        id: 'backend-a', title: 'Backend A', kind: 'backend', targetFiles: ['src/server/services/shared.ts'], targetSymbols: ['a'], evidence: [],
        dependsOn: [], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['test A'], blockers: [], runnable: true,
      },
      {
        id: 'backend-b', title: 'Backend B', kind: 'backend', targetFiles: ['src/server/services/shared.ts'], targetSymbols: ['b'], evidence: [],
        dependsOn: [], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['test B'], blockers: [], runnable: true,
      },
      {
        id: 'verification', title: 'Verify', kind: 'verification', targetFiles: ['tests/server/shared.test.ts'], targetSymbols: [], evidence: [],
        dependsOn: ['backend-a', 'backend-b'], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['run shared tests'], blockers: [], runnable: false,
      },
    ],
    edges: [
      { from: 'backend-a', to: 'verification', kind: 'verification', reason: 'verify' },
      { from: 'backend-b', to: 'verification', kind: 'verification', reason: 'verify' },
    ],
    runnableNow: ['backend-a', 'backend-b'], blocked: [], parallelGroups: [['backend-a', 'backend-b']], warnings: [],
  };
  const result = buildDecompositionCardPlan({ projectId: 'project-1', parentTitle: 'Unsafe split', createRequested: true, decomposition });

  assert.equal(result.evaluation.ok, false);
  assert.equal(result.creationPayload, undefined);
  assert.ok(result.evaluation.errors.some((error) => /overlap/i.test(error)));
  assert.ok(result.evaluation.overlaps.some((entry) => entry.path === 'src/server/services/shared.ts' && entry.explained === false));
});

test('buildDecompositionCardPlan scores likely unnecessary same-scope sibling splitting', () => {
  const decomposition: any = {
    schemaVersion: 1,
    repoRevision: 'rev-split',
    nodes: [
      {
        id: 'backend-a', title: 'Backend A', kind: 'backend', targetFiles: ['src/server/services/a.ts'], targetSymbols: ['a'], evidence: [],
        dependsOn: [], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['test A'], blockers: [], runnable: true,
      },
      {
        id: 'backend-b', title: 'Backend B', kind: 'backend', targetFiles: ['src/server/services/b.ts'], targetSymbols: ['b'], evidence: [],
        dependsOn: [], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['test B'], blockers: [], runnable: true,
      },
      {
        id: 'verification', title: 'Verify', kind: 'verification', targetFiles: ['tests/server/services.test.ts'], targetSymbols: [], evidence: [],
        dependsOn: ['backend-a', 'backend-b'], uncertainty: 'low', conflictRisk: 'low', verificationOwnership: ['run tests'], blockers: [], runnable: false,
      },
    ],
    edges: [
      { from: 'backend-a', to: 'verification', kind: 'verification', reason: 'verify' },
      { from: 'backend-b', to: 'verification', kind: 'verification', reason: 'verify' },
    ],
    runnableNow: ['backend-a', 'backend-b'], blocked: [], parallelGroups: [['backend-a', 'backend-b']], warnings: [],
  };
  const result = buildDecompositionCardPlan({ projectId: 'project-1', parentTitle: 'Over-split plan', decomposition });

  assert.equal(result.evaluation.ok, true);
  assert.equal(result.evaluation.unnecessarySplits.length, 1);
  assert.deepEqual(result.evaluation.unnecessarySplits[0].nodeIds, ['backend-a', 'backend-b']);
  assert.ok(result.evaluation.warnings.some((warning) => /unnecessary split/i.test(warning)));
  assert.ok(result.evaluation.score < 100);
});

test('buildDecompositionCardPlan reports dangling dependency quality failures', () => {
  const decomposition: any = crossLayerDag();
  decomposition.edges = [...decomposition.edges, { from: 'missing-node', to: 'backend', kind: 'prerequisite', reason: 'bad fixture' }];
  const result = buildDecompositionCardPlan({ projectId: 'project-1', parentTitle: 'Broken DAG', createRequested: true, decomposition });

  assert.equal(result.evaluation.ok, false);
  assert.equal(result.creationPayload, undefined);
  assert.ok(result.evaluation.missingDependencies.includes('missing-node'));
});
