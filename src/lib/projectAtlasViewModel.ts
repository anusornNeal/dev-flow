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

export type AtlasDomainFilter = 'CODE' | 'CONFIG' | 'DOCS' | 'INFRA' | 'DATA' | 'DOMAIN';

export interface AtlasDomainFile {
  id: string;
  name: string;
  path: string;
  type: string;
  kind: AtlasNode['kind'];
}

export interface AtlasDomainMapNode {
  id: string;
  title: string;
  description: string;
  status: string;
  category: AtlasDomainFilter;
  tags: string[];
  metrics: {
    files: number;
    nodes: number;
    dependencies: number;
    types: number;
  };
  files: AtlasDomainFile[];
  fileTypeCounts: Record<string, number>;
  technologies: string[];
  sourceNodeIds: string[];
  searchText: string;
}

export interface AtlasDomainMapEdge {
  id: string;
  source: string;
  target: string;
  kind: AtlasEdgeKind;
  label: string;
  sourceEdgeIds: string[];
}

export interface AtlasDomainMapViewModel {
  nodes: AtlasDomainMapNode[];
  edges: AtlasDomainMapEdge[];
  matchedNodeIds: string[];
  activeFilters: AtlasDomainFilter[];
  hasQuery: boolean;
}

export interface BuildDomainMapViewModelOptions {
  query?: string;
  activeFilters?: AtlasDomainFilter[];
}

export interface AtlasDomainRelationship {
  id: string;
  name: string;
  category: AtlasDomainFilter;
  edgeKinds: AtlasEdgeKind[];
}

export interface AtlasDomainInspectorViewModel extends AtlasDomainMapNode {
  name: string;
  health: string;
  plainSummary: string;
  startHereFiles: AtlasDomainFile[];
  incomingDomains: AtlasDomainRelationship[];
  outgoingDomains: AtlasDomainRelationship[];
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

export function buildDomainMapViewModel(
  atlas: Pick<ProjectAtlas, 'nodes' | 'edges' | 'domains'>,
  options: BuildDomainMapViewModelOptions = {},
): AtlasDomainMapViewModel {
  const query = options.query?.trim().toLowerCase() ?? '';
  const activeFilters = options.activeFilters ?? [];
  const nodesById = new Map(atlas.nodes.map((node) => [node.id, node]));
  const domainByNodeId = new Map<string, string>();
  for (const domain of atlas.domains) {
    for (const nodeId of domain.nodeIds) domainByNodeId.set(nodeId, domain.id);
  }

  const dependencyCounts = new Map<string, number>();
  const edgeGroups = new Map<string, AtlasDomainMapEdge>();
  for (const edge of atlas.edges) {
    const sourceDomain = domainByNodeId.get(edge.source) ?? (edge.source.startsWith('domain:') ? edge.source : undefined);
    const targetDomain = domainByNodeId.get(edge.target) ?? (edge.target.startsWith('domain:') ? edge.target : undefined);
    if (!sourceDomain || !targetDomain || sourceDomain === targetDomain) continue;

    dependencyCounts.set(sourceDomain, (dependencyCounts.get(sourceDomain) ?? 0) + 1);
    dependencyCounts.set(targetDomain, (dependencyCounts.get(targetDomain) ?? 0) + 1);
    const id = `${edge.kind}:${sourceDomain}->${targetDomain}`;
    const existing = edgeGroups.get(id);
    if (existing) {
      existing.sourceEdgeIds.push(edge.id);
    } else {
      edgeGroups.set(id, {
        id,
        source: sourceDomain,
        target: targetDomain,
        kind: edge.kind,
        label: readableEdgeLabel(edge.kind),
        sourceEdgeIds: [edge.id],
      });
    }
  }

  const domainNodes = atlas.domains
    .map((domain) => {
      const sourceNodes = domain.nodeIds.map((nodeId) => nodesById.get(nodeId)).filter((node): node is AtlasNode => Boolean(node));
      return buildDomainMapNode(domain.id, domain.name, domain.origin, domain.summary, sourceNodes, dependencyCounts.get(domain.id) ?? 0);
    })
    .filter((node) => {
      const matchesFilter = activeFilters.length === 0 || activeFilters.includes(node.category);
      const matchesQuery = !query || domainSearchText(node).includes(query);
      return matchesFilter && matchesQuery;
    })
    .sort((left, right) => left.title.localeCompare(right.title));

  const visibleIds = new Set(domainNodes.map((node) => node.id));
  const edges = Array.from(edgeGroups.values())
    .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    nodes: domainNodes,
    edges,
    matchedNodeIds: query ? domainNodes.map((node) => node.id).sort() : [],
    activeFilters,
    hasQuery: Boolean(query),
  };
}

export function buildDomainInspector(
  atlas: Pick<ProjectAtlas, 'nodes' | 'edges' | 'domains'>,
  domainId: string | null,
): AtlasDomainInspectorViewModel | null {
  if (!domainId) return null;
  const view = buildDomainMapViewModel(atlas);
  const node = view.nodes.find((candidate) => candidate.id === domainId);
  if (!node) return null;
  const relationships = buildDomainRelationshipSummary(view.nodes, view.edges, domainId);

  return {
    ...node,
    name: node.title,
    health: deriveHealth(node),
    plainSummary: node.description,
    startHereFiles: rankStartHereFiles(node.files).slice(0, 5),
    incomingDomains: relationships.incoming,
    outgoingDomains: relationships.outgoing,
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

function buildDomainMapNode(
  id: string,
  name: string,
  origin: string,
  summary: string | undefined,
  sourceNodes: AtlasNode[],
  dependencyCount: number,
): AtlasDomainMapNode {
  const files = sourceNodes
    .filter((node) => Boolean(node.path))
    .map((node) => ({
      id: node.id,
      name: node.label,
      path: node.path ?? node.label,
      type: fileExtension(node.path ?? node.label),
      kind: node.kind,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const fileTypeCounts = files.reduce<Record<string, number>>((counts, file) => {
    counts[file.type] = (counts[file.type] ?? 0) + 1;
    return counts;
  }, {});
  const kinds = Array.from(new Set(sourceNodes.map((node) => node.kind))).sort();
  const technologies = collectTechnologies(sourceNodes);
  const category = deriveDomainCategory(id, name, sourceNodes);

  return {
    id,
    title: name,
    description: summary ?? summarizeDomain(name, sourceNodes),
    status: origin,
    category,
    tags: Array.from(new Set([category, ...Object.keys(fileTypeCounts).slice(0, 3), ...kinds.slice(0, 2)])).slice(0, 5),
    metrics: {
      files: files.length,
      nodes: sourceNodes.length,
      dependencies: dependencyCount,
      types: kinds.length,
    },
    files,
    fileTypeCounts,
    technologies,
    sourceNodeIds: sourceNodes.map((node) => node.id).sort(),
    searchText: sourceNodes.map((node) => searchableTextForNode(node, new Map())).join(' '),
  };
}

function domainSearchText(node: AtlasDomainMapNode) {
  return [
    node.id,
    node.title,
    node.description,
    node.status,
    node.category,
    ...node.tags,
    ...node.technologies,
    ...node.files.flatMap((file) => [file.name, file.path, file.type]),
    node.searchText,
  ].join(' ').toLowerCase();
}

function fileExtension(path: string) {
  const match = /\.([a-z0-9]+)$/i.exec(path);
  return match?.[1]?.toLowerCase() ?? 'unknown';
}

function collectTechnologies(nodes: AtlasNode[]) {
  const values = nodes.flatMap((node) => [
    node.metadata?.language,
    node.metadata?.framework,
    node.metadata?.runtime,
    node.metadata?.platform,
  ]);
  return Array.from(new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).map((value) => value.trim()))).sort();
}

function deriveDomainCategory(id: string, name: string, nodes: AtlasNode[]): AtlasDomainFilter {
  const normalizedId = id.replace(/^domain:/, '');
  const text = [normalizedId, name, ...nodes.flatMap((node) => [node.kind, node.path, node.label])].join(' ').toLowerCase();
  if (/\b(test|spec|__tests__)\b/.test(text)) return 'DOCS';
  if (/\b(doc|docs|md|readme)\b/.test(text)) return 'DOCS';
  if (/\b(config|json|yaml|yml|env|vite|tsconfig)\b/.test(text)) return 'CONFIG';
  if (/\b(db|database|sqlite|migration|schema|data)\b/.test(text)) return 'DATA';
  if (/\b(infra|server|route|api|script|deploy)\b/.test(text)) return 'INFRA';
  if (/\b(domain|usecase|service|repository)\b/.test(text)) return 'DOMAIN';
  return 'CODE';
}

function summarizeDomain(name: string, nodes: AtlasNode[]) {
  const summary = nodes.map((node) => node.userEdited?.notes ?? node.verified?.description ?? node.inferred?.summary).find(Boolean);
  return summary ?? `${name} domain with ${nodes.length} related Atlas item${nodes.length === 1 ? '' : 's'}.`;
}

function readableEdgeLabel(kind: AtlasEdgeKind) {
  if (kind === 'depends-on') return 'depends on';
  return kind;
}

function buildDomainRelationshipSummary(
  nodes: AtlasDomainMapNode[],
  edges: AtlasDomainMapEdge[],
  domainId: string,
) {
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, AtlasDomainRelationship>();
  const outgoing = new Map<string, AtlasDomainRelationship>();

  for (const edge of edges) {
    if (edge.target === domainId) {
      addDomainRelationship(incoming, nodesById.get(edge.source), edge.kind);
    }
    if (edge.source === domainId) {
      addDomainRelationship(outgoing, nodesById.get(edge.target), edge.kind);
    }
  }

  return {
    incoming: sortDomainRelationships(Array.from(incoming.values())),
    outgoing: sortDomainRelationships(Array.from(outgoing.values())),
  };
}

function addDomainRelationship(
  relationships: Map<string, AtlasDomainRelationship>,
  node: AtlasDomainMapNode | undefined,
  kind: AtlasEdgeKind,
) {
  if (!node) return;
  const existing = relationships.get(node.id);
  if (existing) {
    existing.edgeKinds = Array.from(new Set([...existing.edgeKinds, kind])).sort();
    return;
  }
  relationships.set(node.id, {
    id: node.id,
    name: node.title,
    category: node.category,
    edgeKinds: [kind],
  });
}

function sortDomainRelationships(relationships: AtlasDomainRelationship[]) {
  return relationships.sort((left, right) => left.name.localeCompare(right.name));
}

function rankStartHereFiles(files: AtlasDomainFile[]) {
  return [...files].sort((left, right) => {
    const scoreDelta = startHereScore(right) - startHereScore(left);
    if (scoreDelta !== 0) return scoreDelta;
    return left.path.localeCompare(right.path);
  });
}

function startHereScore(file: AtlasDomainFile) {
  const path = file.path.toLowerCase();
  const name = file.name.toLowerCase();
  let score = 0;

  if (/(^|\/)readme\.md$/.test(path)) score += 100;
  if (/\b(docs?|guide|overview|architecture)\b/.test(path)) score += 80;
  if (/\b(app|index|main)\.(tsx?|jsx?)$/.test(name)) score += 70;
  if (/\b(page|screen|view|component)\b/.test(path)) score += 60;
  if (/\b(viewmodel|usecase|service|repository)\b/.test(path)) score += 55;
  if (/\b(route|api|controller)\b/.test(path)) score += 45;
  if (/\b(schema|migration|config|settings)\b/.test(path)) score += 35;
  if (file.kind === 'component') score += 20;
  if (file.kind === 'route') score += 18;
  if (file.kind === 'database') score += 15;
  if (file.kind === 'test') score -= 20;

  return score;
}

function deriveHealth(node: AtlasDomainMapNode) {
  if (node.metrics.files === 0 && node.metrics.nodes === 0) return 'empty';
  return 'unknown';
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
