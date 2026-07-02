import type { AtlasFreshness, ProjectAtlas } from '../../types.js';
import type { Project } from '../../types.js';
import { renderAtlasMarkdown } from '../../lib/projectAtlasExport.js';
import { buildProjectAtlasPrompt, PROJECT_ATLAS_PROMPT_VARIANTS, type ProjectAtlasPromptVariantId } from '../../lib/projectAtlasPromptTemplates.js';
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
  taskTitle?: string;
  targetFiles?: string[];
  promptVariant?: ProjectAtlasPromptVariantId;
  selectedNodeId?: string;
  diffSummary?: string;
}

export interface AtlasTaskLike {
  title?: string;
  description?: string;
  repoContext?: string;
  reasoning?: string;
  targetFiles?: string[];
  tags?: string[];
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
    return withAtlasPromptTemplate({
      ...base,
      format: 'markdown',
      markdown: renderAtlasMarkdown(atlas),
      guidance: mode === 'agent-context'
        ? 'Use domains and key nodes to choose focused files before broader repo reads.'
        : 'Use this compact Atlas overview as project map context.',
    }, atlas, input);
  }

  if (mode === 'task-focused') {
    const query = input.query || input.focusPath || input.taskId || '';
    const matches = searchAtlas(atlas, query).matchedNodeIds.slice(0, limit);
    const selectedNodeId = matches.find((id) => atlas.nodes.some((node) => node.id === id));
    return withAtlasPromptTemplate({
      ...base,
      query,
      matchedNodeIds: matches,
      selectedContext: selectedNodeId ? buildNodeContext(atlas, selectedNodeId) : '',
      nodes: atlas.nodes.filter((node) => matches.includes(node.id)).slice(0, limit),
      edges: atlas.edges.filter((edge) => matches.includes(edge.source) || matches.includes(edge.target)).slice(0, limit),
    }, atlas, { ...input, selectedNodeId: input.selectedNodeId ?? selectedNodeId });
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

  if (mode === 'compact') return withAtlasPromptTemplate(compact, atlas, input);

  return withAtlasPromptTemplate({
    ...compact,
    nodes: [...atlas.nodes].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit),
    edges: [...atlas.edges].sort((left, right) => left.id.localeCompare(right.id)).slice(0, limit),
    truncated: atlas.nodes.length > limit || atlas.edges.length > limit,
  }, atlas, input);
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

export function shouldIncludeAtlasForTask(task: AtlasTaskLike, input: { explicit?: boolean } = {}) {
  if (input.explicit) return { include: true, reason: 'explicit-request' };
  const targetFiles = Array.isArray(task.targetFiles) ? task.targetFiles.filter(Boolean) : [];
  if (targetFiles.length === 0) return { include: true, reason: 'missing-target-files' };
  if (targetFiles.length >= 5) return { include: true, reason: 'cross-module-target-files' };

  const haystack = [
    task.title,
    task.description,
    task.repoContext,
    task.reasoning,
    ...(Array.isArray(task.tags) ? task.tags : []),
  ].filter(Boolean).join(' ').toLowerCase();
  if (/\b(project atlas|architecture|project structure|onboarding|cross-module|module boundary|read order)\b/.test(haystack)) {
    return { include: true, reason: 'architecture-or-cross-module-language' };
  }
  return { include: false, reason: 'focused-task' };
}

export function getTaskFocusedAtlasContext(project: Project, task: AtlasTaskLike, input: { explicit?: boolean; limit?: number } = {}) {
  const decision = shouldIncludeAtlasForTask(task, input);
  if (!decision.include) return undefined;

  const query = buildTaskAtlasFocusQuery(task);
  const atlas = getProjectAtlasForApi(project, {
    mode: 'task-focused',
    query,
    limit: input.limit ?? 40,
  }) as any;
  const readOrder = Array.isArray(atlas.nodes)
    ? atlas.nodes.map((node: any) => node.path || node.label).filter(Boolean).slice(0, 12)
    : [];

  return {
    included: true,
    reason: decision.reason,
    mode: 'task-focused',
    stale: atlas.stale,
    generatedAt: atlas.generatedAt,
    matchedNodeIds: atlas.matchedNodeIds,
    recommendedReadOrder: readOrder,
    markdown: [
      '## Project Atlas Task Context',
      '',
      `Reason: ${decision.reason}`,
      `Freshness: ${atlas.freshness?.status ?? 'unknown'}${atlas.generatedAt ? ` (${atlas.generatedAt})` : ''}`,
      '',
      '### Recommended Read Order',
      ...(readOrder.length ? readOrder.map((entry: string) => `- ${entry}`) : ['- No focused Atlas nodes matched; use repo context bundle before broad reads.']),
      '',
      '### Boundaries and Guardrails',
      '- Treat verified Atlas facts as navigation hints, not permission to edit unrelated modules.',
      '- Keep explicit targetFiles and implementation maps authoritative over inferred Atlas suggestions.',
      '- Read related tests before changing behavior when Atlas surfaces test links.',
      atlas.selectedContext ? ['', '### Selected Node Context', '```text', atlas.selectedContext, '```'] : undefined,
    ].flat().filter(Boolean).join('\n'),
  };
}

function buildTaskAtlasFocusQuery(task: AtlasTaskLike) {
  const targetFiles = Array.isArray(task.targetFiles) ? task.targetFiles.filter(Boolean) : [];
  if (targetFiles.length > 0) return targetFiles.join(' ').slice(0, 800);
  const text = [task.title, task.description, task.repoContext].filter(Boolean).join(' ');
  const pathLike = text.match(/[A-Za-z0-9_.-]+(?:\/|\\)[A-Za-z0-9_./\\-]+/g);
  if (pathLike?.length) return pathLike.slice(0, 8).join(' ');
  return text.slice(0, 800);
}

function withAtlasPromptTemplate<T extends Record<string, unknown>>(response: T, atlas: any, input: ProjectAtlasApiInput): T {
  if (!input.promptVariant) {
    return {
      ...response,
      promptTemplates: PROJECT_ATLAS_PROMPT_VARIANTS,
    };
  }

  return {
    ...response,
    promptTemplates: PROJECT_ATLAS_PROMPT_VARIANTS,
    promptTemplate: {
      variantId: input.promptVariant,
      prompt: buildProjectAtlasPrompt(input.promptVariant, atlas, {
        selectedNodeId: input.selectedNodeId,
        diffSummary: input.diffSummary,
        task: input.taskId || input.taskTitle || input.targetFiles?.length
          ? {
              id: input.taskId,
              title: input.taskTitle,
              targetFiles: input.targetFiles,
            }
          : undefined,
      }),
    },
  };
}

function normalizeAtlasLimit(value: unknown, fallback: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), MAX_ATLAS_OUTPUT_LIMIT);
}
