import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkDecompositionUseCase } from '../../src/server/useCases/workDecompositionUseCase.js';

test('buildWorkDecompositionUseCase composes repo index, Atlas, and session evidence', () => {
  const calls: string[] = [];
  const result = buildWorkDecompositionUseCase({} as any, {
    projectId: 'project-1',
    title: 'Update account service and screen',
    description: 'Change shared account behavior and verify it.',
    targetFiles: ['src/server/services/accountService.ts'],
    sessionEvidence: {
      repoRevision: 'session-rev',
      inspectedFiles: [{ path: 'src/server/services/accountService.ts', symbols: ['updateAccount'], revision: 'file-rev' }],
      verificationFiles: ['tests/server/accountService.test.ts'],
    },
  }, {
    findProject: () => ({ id: 'project-1', name: 'Fixture', localPath: '/fixture' } as any),
    getRepoIndex: (_state, args) => {
      calls.push(`repo:${args.q}`);
      return {
        cache: { lineageToken: 'lineage-1' },
        matches: [
          { path: 'src/server/services/accountService.ts', symbols: ['updateAccount'], imports: [], score: 9 },
          { path: 'src/components/AccountPanel.tsx', symbols: ['AccountPanel'], imports: [], score: 7 },
        ],
      } as any;
    },
    getAtlas: (_project, args) => {
      calls.push(`atlas:${args.mode}`);
      return {
        stale: false,
        matchedNodeIds: ['file:src/server/services/accountService.ts'],
        impact: {
          relatedTests: ['tests/server/accountService.test.ts'],
          warnings: [],
        },
      } as any;
    },
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith('repo:'));
  assert.equal(calls[1], 'atlas:task-focused');
  assert.equal(result.evidence.repoMatchCount, 2);
  assert.equal(result.evidence.atlasMatchedNodeCount, 1);
  assert.equal(result.evidence.sessionEvidenceUsed, true);
  const backend = result.decomposition.nodes.find((node) => node.id === 'backend');
  assert.ok(backend?.evidence.some((item) => item.source === 'session' && item.revision === 'file-rev'));
  const verification = result.decomposition.nodes.find((node) => node.id === 'verification');
  assert.ok(verification?.targetFiles.includes('tests/server/accountService.test.ts'));
});

test('buildWorkDecompositionUseCase degrades to repo evidence when Atlas lookup fails', () => {
  const result = buildWorkDecompositionUseCase({} as any, {
    projectId: 'project-1',
    title: 'Fix repository update',
  }, {
    findProject: () => ({ id: 'project-1', name: 'Fixture', localPath: '/fixture' } as any),
    getRepoIndex: () => ({
      repoRevision: 'rev-1',
      cache: { lineageToken: 'lineage-1' },
      matches: [{ path: 'src/server/repositories/taskRepository.ts', symbols: ['saveTask'], score: 8 }],
    } as any),
    getAtlas: () => {
      throw new Error('Atlas unavailable');
    },
  });

  assert.deepEqual(result.decomposition.runnableNow, ['backend']);
  assert.ok(result.decomposition.warnings.some((warning) => /Atlas unavailable/i.test(warning)));
  assert.equal(result.evidence.atlasAvailable, false);
});

test('buildWorkDecompositionUseCase rejects unresolved projects instead of inventing targets', () => {
  assert.throws(() => buildWorkDecompositionUseCase({} as any, {
    projectId: 'missing',
    title: 'Do something',
  }, {
    findProject: () => undefined,
    getRepoIndex: () => ({ matches: [] } as any),
    getAtlas: () => ({} as any),
  }), /Project could not be resolved/i);
});
