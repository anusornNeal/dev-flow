import type { AtlasFreshness, ProjectAtlas } from '../../types.js';
import type { Project } from '../../types.js';
import { renderAtlasMarkdown } from '../../lib/projectAtlasExport.js';
import { searchAtlas, buildNodeContext } from '../../lib/projectAtlasViewModel.js';
import {
  isAtlasStale,
  readAtlasCache,
  shouldRefreshAtlasForDailyOpen,
  writeAtlasCache,
} from './projectAtlasCacheService.js';
import { suggestAtlasDomains } from './projectAtlasDomainService.js';
import { scanProjectForAtlas } from './projectAtlasScannerService.js';

export type ProjectAtlasApiMode = 'compact' | 'standard' | 'full' | 'chatgpt-context' | 'agent-context' | 'task-focused';

export interface ProjectAtlasApiInput {
  mode?: ProjectAtlasApiMode;
  limit?: number;
  query?: string;
  focusPath?: string;
  taskId?: string;
}

const DEFAULT_ATLAS_OUTPUT_LIMIT = 80;
const MAX_ATLAS_OUTPUT_LIMIT = 1000;

export function readLatestAtlas(projectId: string) {
  return readAtlasCache({ projectId });
}

export function saveLatestAtlas(atlas: ProjectAtlas) {
  return writeAtlasCache({ atlas });
}

export function getAtlasFreshness(projectId: string) {
  return readLatestAtlas(projectId).atlas.freshness;
}

export function getAtlasRefreshStatus(
  freshness: AtlasFreshness,
  input: { now?: string; repoFingerprint?: string; manualRescan?: boolean } = {},
) {
  const stale = isAtlasStale(freshness, input);
  return {
    stale,
    dailyOpenRefreshEligible: shouldRefreshAtlasForDailyOpen(
      stale ? { ...freshness, status: freshness.status === 'fresh' ? 'stale' : freshness.status } : freshness,
      { now: input.now },
    ),
  };
}

export function getProjectAtlasForApi(project: Project, input: ProjectAtlasApiInput = {}) {
  const mode = input.mode ?? 'compact';
  const limit = normalizeAtlasLimit(input.limit, mode === 'full' ? 500 : DEFAULT_ATLAS_OUTPUT_LIMIT);
  const cached = readLatestAtlas(project.id);
  const atlas = cached.status === 'ok' ? suggestAtlasDomains(cached.atlas) : cached.atlas;
  const status = getProjectAtlasStatus(project.id);
  const base = {
    mode,
    projectId: project.id,
    projectName: project.name,
    stale: status.stale,
    generatedAt: status.generatedAt,
    freshness: atlas.freshness,
    cacheStatus: cached.status,
  };

  if (mode === 'chatgpt-context' || mode === 'agent-context') {
    return {
      ...base,
      format: 'markdown',
      markdown: renderAtlasMarkdown(atlas),
      guidance: mode === 'agent-context'
        ? 'Use domains and key nodes to choose focused files before broader repo reads.'
        : 'Use this compact Atlas overview as project map context.',
    };
  }

  if (mode === 'task-focused') {
    const query = input.query || input.focusPath || input.taskId || '';
    const matches = searchAtlas(atlas, query).matchedNodeIds.slice(0, limit);
    const selectedNodeId = matches.find((id) => atlas.nodes.some((node) => node.id === id));
    return {
      ...base,
      query,
      matchedNodeIds: matches,
      selectedContext: selectedNodeId ? buildNodeContext(atlas, selectedNodeId) : '',
      nodes: atlas.nodes.filter((node) => matches.includes(node.id)).slice(0, limit),
      edges: atlas.edges.filter((edge) => matches.includes(edge.source) || matches.includes(edge.target)).slice(0, limit),
    };
  }

  const compact = {
    ...base,
    nodeCount: atlas.nodes.length,
    edgeCount: atlas.edges.length,
    domainCount: atlas.domains.length,
    domains: [...atlas.domains]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, Math.min(limit, 40))
      .map((domain) => ({
        id: domain.id,
        name: domain.name,
        origin: domain.origin,
        nodeCount: domain.nodeIds.length,
        summary: domain.summary,
      })),
    keyNodes: [...atlas.nodes]
      .sort((left, right) => (left.path ?? left.label).localeCompare(right.path ?? right.label))
      .slice(0, Math.min(limit, 80))
      .map((node) => ({ id: node.id, label: node.label, kind: node.kind, path: node.path })),
  };

  if (mode === 'compact') return compact;

  return {
    ...compact,
    nodes: [...atlas.nodes].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit),
    edges: [...atlas.edges].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit),
    truncated: atlas.nodes.length > limit || atlas.edges.length > limit,
  };
}

export function rescanProjectAtlas(project: Project) {
  if (!project.localPath) {
    throw new Error('Project has no localPath configured for Atlas scan');
  }
  const result = scanProjectForAtlas({ projectId: project.id, root: project.localPath });
  const atlas = suggestAtlasDomains(result.atlas);
  saveLatestAtlas(atlas);
  return {
    projectId: project.id,
    atlas,
    scanStats: result.scanStats,
    status: getProjectAtlasStatus(project.id),
  };
}

export function getProjectAtlasStatus(projectId: string) {
  const cached = readLatestAtlas(projectId);
  const freshness = cached.atlas.freshness;
  return {
    projectId,
    cacheStatus: cached.status,
    stale: isAtlasStale(freshness),
    generatedAt: freshness.generatedAt,
    freshness,
    nodeCount: cached.atlas.nodes.length,
    edgeCount: cached.atlas.edges.length,
    domainCount: cached.atlas.domains.length,
    lastError: cached.error ?? freshness.lastError,
    warnings: [],
  };
}

function normalizeAtlasLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_ATLAS_OUTPUT_LIMIT);
}
