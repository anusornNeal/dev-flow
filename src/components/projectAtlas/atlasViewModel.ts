import type { AtlasDomainSummary, AtlasEdge, AtlasNode, ProjectAtlas } from '../../types.js';

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
  const domains = atlas.domains.map((domain) => ({
    id: domain.id,
    name: domain.name,
    origin: domain.origin,
    nodeCount: domain.nodeIds.length,
    fileCount: domain.nodeIds.length,
  })).sort((left, right) => left.name.localeCompare(right.name));

  const nodes = (collapsedDomains
    ? domains.map((domain) => ({
        id: domain.id,
        label: domain.name,
        kind: 'domain' as const,
        metadata: { nodeCount: domain.nodeCount, origin: domain.origin },
      }))
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
