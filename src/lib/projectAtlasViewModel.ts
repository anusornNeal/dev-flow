import type { AtlasDomainSummary, AtlasEdge, AtlasEdgeKind, AtlasNode, ProjectAtlas } from '../types.js';

export type AtlasLayerKey =
  | 'domains'
  | 'folders'
  | 'files'
  | 'components'
  | 'routes'
  | 'database'
  | 'tests'
  | 'skills'
  | 'inferred';

export interface AtlasLayerState {
  label: string;
  visible: boolean;
}

export type AtlasLayers = Record<AtlasLayerKey, AtlasLayerState>;

export interface AtlasGraphViewModel {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  domains: AtlasDomainSummary[];
  layers: AtlasLayers;
}

export interface BuildAtlasGraphViewModelOptions {
  collapsedDomains?: boolean;
  layers?: AtlasLayers;
  matchedNodeIds?: string[];
  expandedNodeIds?: string[];
}

export interface AtlasSearchResult {
  query: string;
  matchedNodeIds: string[];
}

export interface AtlasRelationshipGroup {
  kind: AtlasEdgeKind;
  incoming: AtlasRelatedNode[];
  outgoing: AtlasRelatedNode[];
}

export interface AtlasRelatedNode {
  edge: AtlasEdge;
  node: AtlasNode;
}

export const DEFAULT_ATLAS_LAYERS: AtlasLayers = {
  domains: { label: 'Domains', visible: true },
  folders: { label: 'Folders', visible: false },
  files: { label: 'Files', visible: false },
  components: { label: 'Components', visible: true },
  routes: { label: 'Routes', visible: true },
  database: { label: 'Database', visible: true },
  tests: { label: 'Tests', visible: true },
  skills: { label: 'Skills', visible: true },
  inferred: { label: 'Inferred', visible: true },
};

export function toggleAtlasLayer(layers: AtlasLayers = DEFAULT_ATLAS_LAYERS, key: AtlasLayerKey): AtlasLayers {
  return {
    ...layers,
    [key]: {
      ...layers[key],
      visible: !layers[key].visible,
    },
  };
}

export function buildAtlasGraphViewModel(
  atlas: Pick<ProjectAtlas, 'nodes' | 'edges' | 'domains'>,
  options: BuildAtlasGraphViewModelOptions = {},
): AtlasGraphViewModel {
  const layers = options.layers ?? DEFAULT_ATLAS_LAYERS;
  const collapsedDomains = options.collapsedDomains ?? true;
  const matchedNodeIds = new Set(options.matchedNodeIds ?? []);
  const expandedNodeIds = new Set(options.expandedNodeIds ?? []);
  const domains = atlas.domains.map((domain) => ({
    id: domain.id,
    name: domain.name,
    origin: domain.origin,
    nodeCount: domain.nodeIds.length,
    fileCount: domain.nodeIds.length,
  })).sort((left, right) => left.name.localeCompare(right.name));

  const expandedDomainNodeIds = new Set(
    atlas.domains
      .filter((domain) => expandedNodeIds.has(domain.id))
      .flatMap((domain) => domain.nodeIds),
  );
  const expandedNeighborhoodNodeIds = new Set<string>();
  for (const edge of atlas.edges) {
    if (expandedNodeIds.has(edge.source)) {
      expandedNeighborhoodNodeIds.add(edge.source);
      expandedNeighborhoodNodeIds.add(edge.target);
    }
    if (expandedNodeIds.has(edge.target)) {
      expandedNeighborhoodNodeIds.add(edge.target);
      expandedNeighborhoodNodeIds.add(edge.source);
    }
  }

  const nodes = (collapsedDomains
    ? [
        ...domains.map((domain) => ({
          id: domain.id,
          label: domain.name,
          kind: 'domain' as const,
          metadata: { nodeCount: domain.nodeCount, origin: domain.origin },
        })),
        ...atlas.nodes.filter((node) => expandedDomainNodeIds.has(node.id) || expandedNeighborhoodNodeIds.has(node.id) || matchedNodeIds.has(node.id)),
      ]
    : atlas.nodes
  ).filter((node) => isNodeVisible(node, layers, collapsedDomains));

  const visibleIds = new Set(nodes.map((node) => node.id));
  const edges = atlas.edges.filter((edge) =>
    visibleIds.has(edge.source) &&
    visibleIds.has(edge.target) &&
    (layers.inferred.visible || edge.fact?.source !== 'inferred')
  );

  return { nodes, edges, domains, layers };
}

export function searchAtlas(atlas: Pick<ProjectAtlas, 'nodes' | 'domains'>, query: string): AtlasSearchResult {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return { query, matchedNodeIds: [] };

  const domainNamesById = new Map(atlas.domains.map((domain) => [domain.id, domain.name]));
  const matchedNodeIds = atlas.nodes
    .filter((node) => searchableTextForNode(node, domainNamesById).includes(normalizedQuery))
    .map((node) => node.id)
    .sort();

  const matchedDomainIds = atlas.domains
    .filter((domain) => [
      domain.id,
      domain.name,
      domain.summary,
      domain.origin,
      ...domain.nodeIds,
    ].filter(Boolean).join(' ').toLowerCase().includes(normalizedQuery))
    .map((domain) => domain.id);

  return {
    query,
    matchedNodeIds: Array.from(new Set([...matchedDomainIds, ...matchedNodeIds])).sort(),
  };
}

export function buildNodeRelationships(
  atlas: Pick<ProjectAtlas, 'nodes' | 'edges'>,
  nodeId: string,
): AtlasRelationshipGroup[] {
  const nodesById = new Map(atlas.nodes.map((node) => [node.id, node]));
  const groups = new Map<AtlasEdgeKind, AtlasRelationshipGroup>();

  for (const edge of atlas.edges) {
    if (edge.source !== nodeId && edge.target !== nodeId) continue;
    const group = groups.get(edge.kind) ?? { kind: edge.kind, incoming: [], outgoing: [] };
    if (edge.target === nodeId) {
      const node = nodesById.get(edge.source);
      if (node) group.incoming.push({ edge, node });
    }
    if (edge.source === nodeId) {
      const node = nodesById.get(edge.target);
      if (node) group.outgoing.push({ edge, node });
    }
    groups.set(edge.kind, group);
  }

  return Array.from(groups.values()).sort((left, right) => left.kind.localeCompare(right.kind));
}

export function buildNodeContext(atlas: Pick<ProjectAtlas, 'nodes' | 'edges' | 'domains'>, nodeId: string): string {
  const node = atlas.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return '';

  const domain = atlas.domains.find((candidate) => candidate.nodeIds.includes(node.id) || candidate.id === node.id);
  const source = node.userEdited?.source ?? node.verified?.source ?? node.inferred?.source ?? 'unknown';
  const summary = node.userEdited?.notes ?? node.verified?.description ?? node.inferred?.summary;
  const relationships = buildNodeRelationships(atlas, node.id)
    .map((group) => {
      const labels = [...group.incoming, ...group.outgoing].map((item) => item.node.label).sort();
      return labels.length ? `${group.kind}: ${labels.join(', ')}` : '';
    })
    .filter(Boolean);

  return [
    `Node: ${node.label}`,
    node.path ? `Path: ${node.path}` : undefined,
    `Type: ${node.kind}`,
    domain ? `Domain: ${domain.name}` : undefined,
    `Source: ${source}`,
    summary ? `Summary: ${summary}` : undefined,
    relationships.length ? `Relationships: ${relationships.join('; ')}` : undefined,
  ].filter(Boolean).join('\n');
}

function searchableTextForNode(node: AtlasNode, domainNamesById: Map<string, string>) {
  const metadataValues = Object.values(node.metadata ?? {})
    .flatMap((value) => Array.isArray(value) ? value : [value])
    .filter((value): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value));
  const domainId = typeof node.metadata?.domainId === 'string' ? node.metadata.domainId : undefined;

  return [
    node.id,
    node.label,
    node.kind,
    node.path,
    node.verified?.description,
    node.inferred?.summary,
    node.userEdited?.notes,
    domainId,
    domainId ? domainNamesById.get(domainId) : undefined,
    ...metadataValues.map(String),
  ].filter(Boolean).join(' ').toLowerCase();
}

function isNodeVisible(node: AtlasNode, layers: AtlasLayers, collapsedDomains: boolean) {
  if (node.kind === 'domain') {
    if (!layers.domains.visible) return false;
    const domainId = node.id;
    if (domainId === 'domain:tests') return layers.tests.visible;
    if (domainId === 'domain:skills') return layers.skills.visible;
    if (domainId === 'domain:database-persistence') return layers.database.visible;
    if (domainId === 'domain:ui-components') return layers.components.visible;
    return true;
  }
  if (node.kind === 'folder') return layers.folders.visible;
  if (node.kind === 'component') return layers.components.visible;
  if (node.kind === 'route') return layers.routes.visible;
  if (node.kind === 'database') return layers.database.visible;
  if (node.kind === 'test') return layers.tests.visible;
  if (node.path?.startsWith('skills/')) return layers.skills.visible;
  if (node.kind === 'file') return layers.files.visible || !collapsedDomains;
  return true;
}
