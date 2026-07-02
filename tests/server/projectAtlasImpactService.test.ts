import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProjectAtlas } from '../../src/types.js';
import {
  buildAtlasDiffImpact,
  buildTaskFocusedAtlasImpact,
  detectAtlasTargetFileWarnings,
} from '../../src/server/services/projectAtlasImpactService.js';

const atlas: ProjectAtlas = {
  schemaVersion: 1,
  projectId: 'project-impact',
  nodes: [
    node('file:src/types.ts', 'types.ts', 'file', 'src/types.ts', 'domain:shared'),
    node('file:src/server/services/taskService.ts', 'taskService.ts', 'file', 'src/server/services/taskService.ts', 'domain:server'),
    node('file:src/server/contracts/devflowContract.ts', 'devflowContract.ts', 'file', 'src/server/contracts/devflowContract.ts', 'domain:mcp'),
    node('file:src/components/TaskDrawer.tsx', 'TaskDrawer.tsx', 'component', 'src/components/TaskDrawer.tsx', 'domain:ui'),
    node('file:tests/server/taskService.test.ts', 'taskService.test.ts', 'test', 'tests/server/taskService.test.ts', 'domain:tests'),
  ],
  edges: [
    edge('edge:service-types', 'file:src/server/services/taskService.ts', 'file:src/types.ts', 'imports'),
    edge('edge:contract-service', 'file:src/server/contracts/devflowContract.ts', 'file:src/server/services/taskService.ts', 'depends-on'),
    edge('edge:ui-service', 'file:src/components/TaskDrawer.tsx', 'file:src/server/services/taskService.ts', 'depends-on'),
    edge('edge:test-service', 'file:tests/server/taskService.test.ts', 'file:src/server/services/taskService.ts', 'tests'),
  ],
  domains: [
    { id: 'domain:shared', name: 'Shared Types', nodeIds: ['file:src/types.ts'], origin: 'verified' },
    { id: 'domain:server', name: 'Server Services', nodeIds: ['file:src/server/services/taskService.ts'], origin: 'verified' },
    { id: 'domain:mcp', name: 'MCP Contract', nodeIds: ['file:src/server/contracts/devflowContract.ts'], origin: 'verified' },
    { id: 'domain:ui', name: 'Task UI', nodeIds: ['file:src/components/TaskDrawer.tsx'], origin: 'inferred' },
    { id: 'domain:tests', name: 'Tests', nodeIds: ['file:tests/server/taskService.test.ts'], origin: 'verified' },
  ],
  flows: [],
  summary: {},
  freshness: { status: 'fresh' },
};

test('buildAtlasDiffImpact maps changed files to direct nodes, domains, neighborhoods, and tests', () => {
  const impact = buildAtlasDiffImpact(atlas, { changedFiles: ['src/server/services/taskService.ts'] });

  assert.deepEqual(impact.changedFiles, ['src/server/services/taskService.ts']);
  assert.ok(impact.directNodes.some((node) => node.path === 'src/server/services/taskService.ts'));
  assert.ok(impact.domains.some((domain) => domain.name === 'Server Services'));
  assert.ok(impact.relatedTests.some((node) => node.path === 'tests/server/taskService.test.ts'));
  assert.ok(impact.neighborhood.edges.some((edge) => edge.kind === 'tests'));
  assert.match(impact.markdown, /Verified direct impact/);
  assert.match(impact.markdown, /Inferred broader impact/);
  assert.match(impact.mermaid, /graph TD/);
});

test('buildTaskFocusedAtlasImpact uses task fields and read order', () => {
  const impact = buildTaskFocusedAtlasImpact(atlas, {
    title: 'Update agent context for task service',
    description: 'MCP contract and task drawer may be affected.',
    repoContext: 'Implementation map:\n- File: src/server/services/taskService.ts',
    targetFiles: ['src/server/services/taskService.ts'],
    checklist: [{ text: 'Update task context output' }],
    tags: ['mcp'],
    branch: 'feature/task-context',
  });

  assert.ok(impact.directNodes.some((node) => node.path === 'src/server/services/taskService.ts'));
  assert.ok(impact.readOrder.some((item) => item.path === 'src/types.ts'));
  assert.ok(impact.relatedTests.some((node) => node.path === 'tests/server/taskService.test.ts'));
  assert.match(impact.compactSummary, /Server Services/);
  assert.match(impact.markdown, /Recommended Read Order/);
});

test('detectAtlasTargetFileWarnings reports missing and conflicting target files without mutation', () => {
  const missing = detectAtlasTargetFileWarnings(atlas, {
    targetFiles: [],
    suggestedNodeIds: ['file:src/server/services/taskService.ts'],
  });
  const conflict = detectAtlasTargetFileWarnings(atlas, {
    targetFiles: ['src/components/TaskDrawer.tsx'],
    suggestedNodeIds: ['file:src/server/services/taskService.ts'],
  });

  assert.match(missing[0].message, /missing targetFiles/i);
  assert.match(conflict[0].message, /conflict/i);
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
