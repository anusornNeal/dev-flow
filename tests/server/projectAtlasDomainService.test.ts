import test from 'node:test';
import assert from 'node:assert/strict';

const {
  applyDomainOverrides,
  summarizeDomainGraph,
  suggestAtlasDomains,
} = await import('../../src/server/services/projectAtlasDomainService.js');

const atlas: any = {
  schemaVersion: 1,
  projectId: 'project-domain-1',
  nodes: [
    { id: 'file:src/server/routes/tasks.ts', label: 'tasks.ts', kind: 'route', path: 'src/server/routes/tasks.ts', metadata: {} },
    { id: 'file:src/server/services/agentRunService.ts', label: 'agentRunService.ts', kind: 'file', path: 'src/server/services/agentRunService.ts', metadata: {} },
    { id: 'file:src/server/contracts/devflowContract.ts', label: 'devflowContract.ts', kind: 'file', path: 'src/server/contracts/devflowContract.ts', metadata: {} },
    { id: 'file:src/lib/chatGptStarterPrompt.ts', label: 'chatGptStarterPrompt.ts', kind: 'file', path: 'src/lib/chatGptStarterPrompt.ts', metadata: {} },
    { id: 'file:skills/01-authoring-core.md', label: '01-authoring-core.md', kind: 'file', path: 'skills/01-authoring-core.md', metadata: {} },
    { id: 'file:src/db/migrations/001_init.ts', label: '001_init.ts', kind: 'database', path: 'src/db/migrations/001_init.ts', metadata: {} },
    { id: 'file:src/components/TaskList.tsx', label: 'TaskList.tsx', kind: 'component', path: 'src/components/TaskList.tsx', metadata: {} },
    { id: 'file:tests/server/taskService.test.ts', label: 'taskService.test.ts', kind: 'test', path: 'tests/server/taskService.test.ts', metadata: {} },
  ],
  edges: [
    {
      id: 'imports:file:src/server/routes/tasks.ts->file:src/server/services/agentRunService.ts',
      source: 'file:src/server/routes/tasks.ts',
      target: 'file:src/server/services/agentRunService.ts',
      kind: 'imports',
      fact: { source: 'verified', description: 'fixture import' },
    },
    {
      id: 'tests:file:tests/server/taskService.test.ts->file:src/server/routes/tasks.ts',
      source: 'file:tests/server/taskService.test.ts',
      target: 'file:src/server/routes/tasks.ts',
      kind: 'tests',
      fact: { source: 'verified', description: 'fixture test link' },
    },
  ],
  domains: [],
  flows: [],
  summary: {},
  freshness: { status: 'fresh' },
};

test('suggestAtlasDomains groups files by deterministic path heuristics', () => {
  const result = suggestAtlasDomains(atlas);
  const domainNames = new Set(result.domains.map((domain: any) => domain.name));
  const nodeById = new Map(result.nodes.map((node: any) => [node.id, node]));

  assert.ok(domainNames.has('Task Management'));
  assert.ok(domainNames.has('Agent Runs'));
  assert.ok(domainNames.has('MCP Tools'));
  assert.ok(domainNames.has('Prompt System'));
  assert.ok(domainNames.has('Skills'));
  assert.ok(domainNames.has('Database/Persistence'));
  assert.ok(domainNames.has('UI Components'));
  assert.ok(domainNames.has('Tests'));

  assert.equal(nodeById.get('file:src/server/routes/tasks.ts').metadata.domainId, 'domain:task-management');
  assert.equal(nodeById.get('file:src/server/routes/tasks.ts').metadata.domainOrigin, 'inferred');
});

test('applyDomainOverrides persists user edits without mutating verified scanner facts', () => {
  const grouped = suggestAtlasDomains(atlas);
  const beforeVerified = grouped.nodes.find((node: any) => node.id === 'file:src/server/routes/tasks.ts').verified;
  const edited = applyDomainOverrides(grouped, {
    projectId: 'project-domain-1',
    domains: [
      {
        id: 'domain:workflow',
        name: 'Workflow',
        nodeIds: ['file:src/server/routes/tasks.ts', 'file:src/components/TaskList.tsx'],
      },
    ],
    updatedAt: '2026-07-02T00:00:00.000Z',
  });
  const workflow = edited.domains.find((domain: any) => domain.id === 'domain:workflow');
  const editedTaskNode = edited.nodes.find((node: any) => node.id === 'file:src/server/routes/tasks.ts');

  assert.equal(workflow.origin, 'user-edited');
  assert.deepEqual(workflow.nodeIds.sort(), ['file:src/components/TaskList.tsx', 'file:src/server/routes/tasks.ts']);
  assert.equal(editedTaskNode.metadata.domainId, 'domain:workflow');
  assert.equal(editedTaskNode.metadata.domainOrigin, 'user-edited');
  assert.deepEqual(editedTaskNode.verified, beforeVerified);
  assert.equal(editedTaskNode.userEdited.source, 'user-edited');
});

test('summarizeDomainGraph returns collapse counts and related-domain edges', () => {
  const grouped = suggestAtlasDomains(atlas);
  const summary = summarizeDomainGraph(grouped);

  assert.ok(summary.domains.some((domain: any) =>
    domain.id === 'domain:task-management' &&
    domain.nodeCount === 1 &&
    domain.fileCount === 1
  ));
  assert.ok(summary.relatedEdges.some((edge: any) =>
    edge.source === 'domain:task-management' &&
    edge.target === 'domain:agent-runs' &&
    edge.kind === 'related'
  ));
  assert.ok(grouped.edges.some((edge: any) =>
    edge.kind === 'related' &&
    edge.source === 'domain:task-management' &&
    edge.target === 'domain:agent-runs' &&
    edge.fact.source === 'inferred'
  ));
});
