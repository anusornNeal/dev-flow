import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectAtlas } from '../../src/types.js';
import {
  PROJECT_ATLAS_PROMPT_VARIANTS,
  buildProjectAtlasPrompt,
} from '../../src/lib/projectAtlasPromptTemplates.js';
import { buildAtlasReadOrder } from '../../src/lib/projectAtlasReadOrder.js';

const atlas: ProjectAtlas = {
  schemaVersion: 1,
  projectId: 'project-atlas-test',
  nodes: [
    node('file:src/types.ts', 'types.ts', 'file', 'src/types.ts', 'domain:shared'),
    node('file:src/domain/useCases.ts', 'useCases.ts', 'file', 'src/domain/useCases.ts', 'domain:domain'),
    node('file:src/server/routes/tasks.ts', 'tasks.ts', 'route', 'src/server/routes/tasks.ts', 'domain:server'),
    node('file:src/components/ProjectAtlasPage.tsx', 'ProjectAtlasPage.tsx', 'component', 'src/components/ProjectAtlasPage.tsx', 'domain:ui'),
    node('file:tests/server/projectAtlas.test.ts', 'projectAtlas.test.ts', 'test', 'tests/server/projectAtlas.test.ts', 'domain:tests'),
    node('file:skills/01-authoring-core.md', '01-authoring-core.md', 'file', 'skills/01-authoring-core.md', 'domain:skills'),
  ],
  edges: [
    edge('edge:route-types', 'file:src/server/routes/tasks.ts', 'file:src/types.ts', 'imports'),
    edge('edge:ui-route', 'file:src/components/ProjectAtlasPage.tsx', 'file:src/server/routes/tasks.ts', 'depends-on'),
    edge('edge:test-route', 'file:tests/server/projectAtlas.test.ts', 'file:src/server/routes/tasks.ts', 'tests'),
  ],
  domains: [
    { id: 'domain:shared', name: 'Shared Types', nodeIds: ['file:src/types.ts'], origin: 'verified', summary: 'Contracts and shared types.' },
    { id: 'domain:domain', name: 'Domain Layer', nodeIds: ['file:src/domain/useCases.ts'], origin: 'verified', summary: 'Use cases and domain rules.' },
    { id: 'domain:server', name: 'Server Routes', nodeIds: ['file:src/server/routes/tasks.ts'], origin: 'verified', summary: 'HTTP routes and services.' },
    { id: 'domain:ui', name: 'UI Components', nodeIds: ['file:src/components/ProjectAtlasPage.tsx'], origin: 'inferred', summary: 'React UI.' },
    { id: 'domain:tests', name: 'Tests', nodeIds: ['file:tests/server/projectAtlas.test.ts'], origin: 'verified', summary: 'Verification files.' },
    { id: 'domain:skills', name: 'Authoring Skills', nodeIds: ['file:skills/01-authoring-core.md'], origin: 'verified', summary: 'Agent and authoring guidance.' },
  ],
  flows: [],
  summary: {
    verified: { source: 'verified', description: 'Project Atlas test graph.' },
    inferred: { source: 'inferred', summary: 'UI depends on server routes.' },
  },
  freshness: { status: 'fresh', generatedAt: '2026-07-02T00:00:00.000Z' },
};

test('buildAtlasReadOrder returns stable architecture-first ordering with tests and skills last', () => {
  const order = buildAtlasReadOrder(atlas);

  assert.deepEqual(order.map((item) => item.path), [
    'src/types.ts',
    'src/domain/useCases.ts',
    'src/server/routes/tasks.ts',
    'src/components/ProjectAtlasPage.tsx',
    'tests/server/projectAtlas.test.ts',
    'skills/01-authoring-core.md',
  ]);
  assert.equal(order[0].reason, 'Shared types/contracts');
  assert.equal(order.at(-1)?.reason, 'Related skills/prompts');
});

test('buildProjectAtlasPrompt supports all variants with caveats and boundaries', () => {
  assert.deepEqual(PROJECT_ATLAS_PROMPT_VARIANTS.map((variant) => variant.id), [
    'explain-project',
    'onboard-repo',
    'find-affected-files',
    'plan-implementation',
    'build-read-order',
    'explain-module',
    'analyze-diff-impact',
  ]);

  for (const variant of PROJECT_ATLAS_PROMPT_VARIANTS) {
    const prompt = buildProjectAtlasPrompt(variant.id, atlas, {
      task: {
        id: 'DVF-0296',
        title: 'Project Atlas prompt templates',
        targetFiles: ['src/lib/projectAtlasPromptTemplates.ts'],
      },
      selectedNodeId: 'file:src/server/routes/tasks.ts',
      diffSummary: 'src/server/routes/tasks.ts changed task context output.',
    });

    assert.match(prompt, /verified/i);
    assert.match(prompt, /inferred/i);
    assert.match(prompt, /Do not edit unrelated modules/i);
    assert.match(prompt, /DVF-0296/);
  }
});

test('task-focused prompt includes task files, domains, tests, and out-of-scope boundary', () => {
  const prompt = buildProjectAtlasPrompt('plan-implementation', atlas, {
    task: {
      id: 'DVF-0296',
      title: 'Project Atlas prompt templates',
      targetFiles: ['src/server/routes/tasks.ts'],
    },
  });

  assert.match(prompt, /Project Atlas prompt templates/);
  assert.match(prompt, /src\/server\/routes\/tasks\.ts/);
  assert.match(prompt, /Server Routes/);
  assert.match(prompt, /tests\/server\/projectAtlas\.test\.ts/);
  assert.match(prompt, /Out of scope/i);
});

function node(id: string, label: string, kind: any, path: string, domainId: string) {
  return {
    id,
    label,
    kind,
    path,
    verified: { source: 'verified' as const, description: `${path} exists.` },
    metadata: { domainId },
  };
}

function edge(id: string, source: string, target: string, kind: any) {
  return {
    id,
    source,
    target,
    kind,
    fact: { source: 'verified' as const, description: `${source} ${kind} ${target}` },
  };
}
