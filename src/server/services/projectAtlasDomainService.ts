import type {
  AtlasDomain,
  AtlasDomainGraphSummary,
  AtlasDomainOverrideMap,
  AtlasEdge,
  AtlasNode,
  ProjectAtlas,
} from '../../types.js';

interface DomainRule {
  id: string;
  name: string;
  test: (node: AtlasNode) => boolean;
}

const DOMAIN_RULES: DomainRule[] = [
  { id: 'domain:tests', name: 'Tests', test: (node) => node.kind === 'test' || /(^|\/)(tests?|__tests__)\//i.test(node.path ?? node.label) },
  { id: 'domain:ui-components', name: 'UI Components', test: (node) => node.kind === 'component' || /(^|\/)(components|viewModels|App\.tsx)/i.test(node.path ?? node.label) },
  { id: 'domain:task-management', name: 'Task Management', test: (node) => /(^|\/)(tasks?|taskService|taskRepository)/i.test(node.path ?? node.label) },
  { id: 'domain:agent-runs', name: 'Agent Runs', test: (node) => /(^|\/)(agent|agentRun|runner)/i.test(node.path ?? node.label) },
  { id: 'domain:mcp-tools', name: 'MCP Tools', test: (node) => /(^|\/)(mcp|contracts|devflowContract)/i.test(node.path ?? node.label) },
  { id: 'domain:prompt-system', name: 'Prompt System', test: (node) => /prompt|chatGptStarter/i.test(node.path ?? node.label) },
  { id: 'domain:skills', name: 'Skills', test: (node) => /(^|\/)skills?\//i.test(node.path ?? node.label) },
  { id: 'domain:project-workspace', name: 'Project/Workspace', test: (node) => /project|workspace/i.test(node.path ?? node.label) },
  { id: 'domain:database-persistence', name: 'Database/Persistence', test: (node) => node.kind === 'database' || /(^|\/)(db|database|migrations?|repositories?)\//i.test(node.path ?? node.label) },
  { id: 'domain:figma-integration', name: 'Figma Integration', test: (node) => /figma/i.test(node.path ?? node.label) },
  { id: 'domain:settings', name: 'Settings', test: (node) => /settings|config\/project-rules/i.test(node.path ?? node.label) },
];

const FALLBACK_DOMAIN = { id: 'domain:other', name: 'Other' };

export function suggestAtlasDomains(atlas: ProjectAtlas): ProjectAtlas {
  const domainMap = new Map<string, AtlasDomain>();
  const nodes = atlas.nodes.map((node) => {
    if (!isDomainAssignable(node)) return node;
    const domain = resolveDomainForNode(node);
    const nextNode = assignNodeToDomain(node, domain.id, 'inferred');
    upsertDomain(domainMap, domain.id, domain.name, nextNode.id, 'inferred');
    return nextNode;
  });
  const edges = withRelatedDomainEdges(atlas.edges, nodes);
  return { ...atlas, nodes, edges, domains: sortedDomains(domainMap) };
}

export function applyDomainOverrides(atlas: ProjectAtlas, overrides: AtlasDomainOverrideMap): ProjectAtlas {
  const overrideByNodeId = new Map<string, AtlasDomain>();
  const domainMap = new Map(atlas.domains.map((domain) => [domain.id, { ...domain, nodeIds: [...domain.nodeIds] }]));

  for (const override of overrides.domains) {
    const domain: AtlasDomain = {
      id: override.id,
      name: override.name,
      nodeIds: [...new Set(override.nodeIds)].sort(),
      origin: 'user-edited',
      metadata: { updatedAt: overrides.updatedAt },
    };
    domainMap.set(domain.id, domain);
    for (const nodeId of domain.nodeIds) {
      overrideByNodeId.set(nodeId, domain);
    }
  }

  const nodes = atlas.nodes.map((node) => {
    const override = overrideByNodeId.get(node.id);
    if (!override) return node;
    return {
      ...assignNodeToDomain(node, override.id, 'user-edited'),
      userEdited: {
        source: 'user-edited' as const,
        notes: `Assigned to domain '${override.name}'`,
        updatedAt: overrides.updatedAt,
      },
    };
  });

  const edges = withRelatedDomainEdges(atlas.edges.filter((edge) => !isDomainRelatedEdge(edge)), nodes);
  return { ...atlas, nodes, edges, domains: sortedDomains(domainMap) };
}

export function summarizeDomainGraph(atlas: ProjectAtlas): AtlasDomainGraphSummary {
  const nodeByDomain = new Map<string, AtlasNode[]>();
  for (const node of atlas.nodes) {
    const domainId = typeof node.metadata?.domainId === 'string' ? node.metadata.domainId : null;
    if (!domainId) continue;
    const nodes = nodeByDomain.get(domainId) ?? [];
    nodes.push(node);
    nodeByDomain.set(domainId, nodes);
  }
  return {
    domains: atlas.domains
      .map((domain) => {
        const nodes = nodeByDomain.get(domain.id) ?? [];
        return {
          id: domain.id,
          name: domain.name,
          origin: domain.origin,
          nodeCount: nodes.length,
          fileCount: nodes.filter((node) => Boolean(node.path)).length,
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name)),
    relatedEdges: atlas.edges.filter(isDomainRelatedEdge),
  };
}

function resolveDomainForNode(node: AtlasNode) {
  return DOMAIN_RULES.find((rule) => rule.test(node)) ?? FALLBACK_DOMAIN;
}

function isDomainAssignable(node: AtlasNode) {
  return node.kind !== 'project' && node.kind !== 'folder' && node.kind !== 'domain';
}

function assignNodeToDomain(node: AtlasNode, domainId: string, origin: 'inferred' | 'user-edited'): AtlasNode {
  return {
    ...node,
    metadata: {
      ...(node.metadata ?? {}),
      domainId,
      domainOrigin: origin,
    },
  };
}

function upsertDomain(domainMap: Map<string, AtlasDomain>, id: string, name: string, nodeId: string, origin: 'inferred' | 'user-edited') {
  const existing = domainMap.get(id);
  if (existing) {
    if (!existing.nodeIds.includes(nodeId)) existing.nodeIds.push(nodeId);
    existing.nodeIds.sort();
    return;
  }
  domainMap.set(id, {
    id,
    name,
    nodeIds: [nodeId],
    origin,
    summary: `${name} files grouped from deterministic path heuristics.`,
  });
}

function withRelatedDomainEdges(edges: AtlasEdge[], nodes: AtlasNode[]) {
  const nodeDomains = new Map(nodes.map((node) => [node.id, typeof node.metadata?.domainId === 'string' ? node.metadata.domainId : null]));
  const nextEdges = edges.filter((edge) => !isDomainRelatedEdge(edge));
  const related = new Map<string, AtlasEdge>();
  for (const edge of nextEdges) {
    const sourceDomain = nodeDomains.get(edge.source);
    const targetDomain = nodeDomains.get(edge.target);
    if (!sourceDomain || !targetDomain || sourceDomain === targetDomain) continue;
    const id = `related:${sourceDomain}->${targetDomain}`;
    if (!related.has(id)) {
      related.set(id, {
        id,
        source: sourceDomain,
        target: targetDomain,
        kind: 'related',
        fact: {
          source: 'inferred',
          summary: `Cross-domain relationship inferred from ${edge.kind} edge.`,
        },
        metadata: { sourceEdgeKinds: [edge.kind] },
      });
      continue;
    }
    const kinds = related.get(id)?.metadata?.sourceEdgeKinds;
    if (Array.isArray(kinds) && !kinds.includes(edge.kind)) kinds.push(edge.kind);
  }
  return [...nextEdges, ...Array.from(related.values())].sort((left, right) => left.id.localeCompare(right.id));
}

function isDomainRelatedEdge(edge: AtlasEdge) {
  return edge.kind === 'related' && edge.source.startsWith('domain:') && edge.target.startsWith('domain:');
}

function sortedDomains(domainMap: Map<string, AtlasDomain>) {
  return Array.from(domainMap.values())
    .map((domain) => ({ ...domain, nodeIds: [...new Set(domain.nodeIds)].sort() }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
