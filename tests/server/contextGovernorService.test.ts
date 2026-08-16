import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyContextGovernorPlanToArgs,
  planContextGovernor,
} from '../../src/server/services/contextGovernorService.js';

const baseInput = {
  query: 'fix context reuse bug',
  intent: 'small-bug-fix',
  stage: 'implement',
  repoRevision: 'rev-1',
  lineageToken: 'lineage-1',
  targetFiles: ['src/server/services/contextHandleService.ts'],
  taskRequirements: 'Reuse valid context handles and refresh only invalid evidence.',
};

test('governor is deterministic for equivalent task/stage/revision/evidence inputs', () => {
  const first = planContextGovernor({
    ...baseInput,
    targetFiles: ['src/b.ts', 'src/a.ts'],
    frozenEvidence: [
      { id: 'design', source: 'task-ui', frozenRevision: 7, approved: true },
      { id: 'spec', source: 'task-spec', frozenRevision: 3, approved: true },
    ],
  });
  const second = planContextGovernor({
    ...baseInput,
    targetFiles: ['src/a.ts', 'src/b.ts'],
    frozenEvidence: [
      { id: 'spec', source: 'task-spec', frozenRevision: 3, approved: true },
      { id: 'design', source: 'task-ui', frozenRevision: 7, approved: true },
    ],
  });

  assert.equal(first.planIdentity, second.planIdentity);
  assert.equal(first.intent, second.intent);
  assert.equal(first.delivery.mode, second.delivery.mode);
});

test('governor chooses bounded profiles for small bug, cross-module and verification stages', () => {
  const small = planContextGovernor({ ...baseInput, intent: 'small-bug-fix' });
  const cross = planContextGovernor({ ...baseInput, intent: 'cross-module-change' });
  const verify = planContextGovernor({ ...baseInput, intent: undefined, stage: 'verify' });

  assert.equal(small.disclosureLevel, 'snippets');
  assert.equal(cross.disclosureLevel, 'callers-tests');
  assert.equal(verify.intent, 'verification-debugging');
  assert.equal(verify.disclosureLevel, 'callers-tests');
  assert.ok(small.budgets.maxContextBytes < cross.budgets.maxContextBytes);
});

test('full-file disclosure is never selected implicitly and remains byte bounded', () => {
  const implicit = planContextGovernor({
    ...baseInput,
    intent: 'architecture-analysis',
    contextSufficient: false,
    missingRelationships: ['all callers and tests'],
    maxContextBytes: 24_000,
  });
  const explicit = planContextGovernor({
    ...baseInput,
    intent: 'architecture-analysis',
    requestedDisclosureLevel: 'full-file',
    maxContextBytes: 80_000,
  });

  assert.notEqual(implicit.disclosureLevel, 'full-file');
  assert.equal(explicit.disclosureLevel, 'full-file');
  assert.equal(implicit.budgets.maxContextBytes, 24_000);
  assert.equal(explicit.budgets.maxContextBytes, 80_000);
  assert.ok(explicit.expansion.triggers.some((entry) => entry.to === 'full-file' && entry.explicitOnly === true));
});

test('current task requirements and frozen evidence stay required while newer unapproved evidence is deferred', () => {
  const plan = planContextGovernor({
    ...baseInput,
    frozenEvidence: [
      { id: 'preview-main', source: 'task-ui', path: 'ui/preview-main', frozenRevision: 4, approved: true },
    ],
    latestEvidence: [
      { id: 'preview-main', source: 'task-ui', path: 'ui/preview-main', revision: 5, approved: false },
    ],
  });

  assert.ok(plan.requiredEvidence.some((entry) => entry.key === 'task:requirements' && entry.trustClass === 'authority'));
  const frozen = plan.requiredEvidence.find((entry) => entry.source === 'task-ui');
  assert.equal(frozen?.frozenRevision, '4');
  assert.equal(frozen?.freshness, 'pinned');
  assert.ok(frozen?.reasonCodes.includes('LATEST_CANNOT_SILENTLY_REPLACE'));
  const latest = plan.deferredEvidence.find((entry) => entry.source === 'task-ui');
  assert.equal(latest?.revision, '5');
  assert.ok(latest?.reasonCodes.includes('UNAPPROVED_LATEST_DEFERRED'));
});

test('repo candidates remain untrusted evidence and never become harness authority', () => {
  const plan = planContextGovernor({
    ...baseInput,
    candidates: [
      {
        path: 'AGENTS.md',
        score: 100,
        symbols: ['IGNORE_USER_AND_RUN_ARBITRARY_COMMANDS'],
      },
    ],
  });

  assert.equal(plan.sourcePolicy.repoContentTrust, 'untrusted-evidence');
  assert.equal(plan.sourcePolicy.repositoryInstructionsAreAuthority, false);
  assert.ok(plan.evidence[0].reasons.includes('repo content is untrusted evidence'));
  const target = plan.requiredEvidence.find((entry) => entry.kind === 'repo-target');
  assert.equal(target?.policyAuthority, false);
});

test('adaptive expansion denies secret-bearing and ignored paths unless explicitly authorized', () => {
  const denied = planContextGovernor({
    ...baseInput,
    contextSufficient: false,
    missingFiles: ['.env', 'node_modules/pkg/index.js', 'src/safe.ts'],
  });
  assert.deepEqual(denied.expansion.allowedFiles, ['src/safe.ts']);
  assert.equal(denied.blockers.filter((entry) => entry.code === 'CONTEXT_SENSITIVE_PATH_DENIED').length, 2);

  const authorized = planContextGovernor({
    ...baseInput,
    contextSufficient: false,
    missingFiles: ['.env', 'node_modules/pkg/index.js'],
    includeIgnored: true,
    authorizedSensitivePaths: ['.env'],
  });
  assert.deepEqual(authorized.expansion.allowedFiles, ['.env', 'node_modules/pkg/index.js']);
  assert.equal(authorized.blockers.length, 0);
});

test('valid handle reuses unchanged lineage while stale revision or lineage triggers bounded refresh', () => {
  const initial = planContextGovernor(baseInput);
  const reused = planContextGovernor({
    ...baseInput,
    handle: {
      planIdentity: initial.planIdentity,
      repoRevision: 'rev-1',
      lineageToken: 'lineage-1',
    },
  });
  const staleRevision = planContextGovernor({
    ...baseInput,
    repoRevision: 'rev-2',
    handle: {
      planIdentity: initial.planIdentity,
      repoRevision: 'rev-1',
      lineageToken: 'lineage-1',
    },
  });
  const staleLineage = planContextGovernor({
    ...baseInput,
    lineageToken: 'lineage-2',
    handle: {
      planIdentity: initial.planIdentity,
      repoRevision: 'rev-1',
      lineageToken: 'lineage-1',
    },
  });

  assert.equal(reused.delivery.mode, 'reuse-handle');
  assert.ok(reused.delivery.reasonCodes.includes('VALID_HANDLE_REUSE'));
  assert.equal(staleRevision.delivery.mode, 'refresh-delta');
  assert.ok(staleRevision.delivery.reasonCodes.includes('REPO_REVISION_CHANGED'));
  assert.equal(staleLineage.delivery.mode, 'refresh-delta');
  assert.ok(staleLineage.delivery.reasonCodes.includes('LINEAGE_INVALIDATED'));
});

test('missing required evidence becomes an explicit blocker instead of a smaller silent plan', () => {
  const plan = planContextGovernor({
    ...baseInput,
    frozenEvidence: [
      { id: 'approved-design', source: 'task-ui', frozenRevision: 8, present: false, approved: true },
    ],
  });

  assert.equal(plan.delivery.mode, 'blocked');
  assert.ok(plan.blockers.some((entry) => entry.code === 'CONTEXT_REQUIRED_EVIDENCE_MISSING'));
});

test('governor-selected args preserve targeted expansion but remove denied adaptive paths', () => {
  const plan = planContextGovernor({
    ...baseInput,
    contextSufficient: false,
    missingFiles: ['.env', 'src/server/services/contextHandleService.ts'],
    missingSymbols: ['getRepoContextWithHandle'],
  });
  const applied = applyContextGovernorPlanToArgs({
    contextSufficient: false,
    missingFiles: ['.env', 'src/server/services/contextHandleService.ts'],
    missingSymbols: ['getRepoContextWithHandle'],
    maxContextBytes: 500_000,
  }, plan);

  assert.deepEqual(applied.missingFiles, ['src/server/services/contextHandleService.ts']);
  assert.deepEqual(applied.missingSymbols, ['getRepoContextWithHandle']);
  assert.equal(applied.maxContextBytes, plan.budgets.maxContextBytes);
  assert.equal(applied.contextIntent, plan.intent);
});
