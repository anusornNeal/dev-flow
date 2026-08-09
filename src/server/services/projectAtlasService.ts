import fs from 'node:fs';
import path from 'node:path';
import type { AtlasFreshness, ProjectAtlas } from '../../types.js';
import type { Project } from '../../types.js';
import { renderAtlasMarkdown } from '../../lib/projectAtlasExport.js';
import { buildProjectAtlasPrompt, PROJECT_ATLAS_PROMPT_VARIANTS, type ProjectAtlasPromptVariantId } from '../../lib/projectAtlasPromptTemplates.js';
import { searchAtlas, buildNodeContext } from '../../lib/projectAtlasViewModel.js';
import { getChangedGitFilesForRoot } from './gitService.js';
import { buildAtlasDiffImpact, buildTaskFocusedAtlasImpact } from './projectAtlasImpactService.js';
import {
  isAtlasStale,
  readAtlasCache,
  writeAtlasCache,
} from './projectAtlasCacheService.js';
import { applyProjectAtlasAgentUpdatePatch, type ApplyProjectAtlasAgentUpdateOptions } from './projectAtlasAgentUpdateService.js';
import { scanProjectForAtlas } from './projectAtlasScannerService.js';
import { getRepoRevisionForRoot, type RepoRevision } from './repoRevisionService.js';

export type ProjectAtlasApiMode = 'compact' | 'standard' | 'full' | 'chatgpt-context' | 'agent-context' | 'task-focused' | 'diff-impact';

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
  changedFiles?: string[];
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

export type ProjectAtlasLifecycleState = 'missing' | 'generating' | 'fresh' | 'stale' | 'failed-retryable';
export type ProjectAtlasRefreshStrategy = 'bootstrap' | 'incremental' | 'full';

export interface ProjectAtlasRefreshInput {
  now?: string;
  repoRevision?: RepoRevision;
  scheduler?: (run: () => void) => void;
}

type ActiveAtlasRefresh = {
  revisionToken?: string;
  strategy: ProjectAtlasRefreshStrategy;
};

const activeAtlasRefreshes = new Map<string, ActiveAtlasRefresh>();
const DEFAULT_INCREMENTAL_FILE_LIMIT = 8;


export function readLatestAtlas(projectId: string) {
  return readAtlasCache({ projectId });
}

export function saveLatestAtlas(atlas: ProjectAtlas) {
  return writeAtlasCache({ atlas });
}

export function getManagedProjectAtlas(atlas: ProjectAtlas) {
  return atlas;
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
    dailyOpenRefreshEligible: false,
  };
}

export function maybeRefreshAtlasOnProjectOpen(project: Project, input: ProjectAtlasRefreshInput = {}) {
  const cached = readLatestAtlas(project.id);
  const freshness = cached.atlas.freshness;
  const repoRevision = resolveAtlasRepoRevision(project, input.repoRevision);
  const stale = isAtlasStale(freshness, {
    now: input.now,
    repoFingerprint: repoRevision?.token,
  });
  const active = activeAtlasRefreshes.get(project.id);

  if (!stale && cached.status === 'ok') {
    return {
      projectId: project.id,
      cacheStatus: cached.status,
      stale: false,
      shouldRefresh: false,
      scheduled: false,
      deduplicated: false,
      lifecycleState: 'fresh' as ProjectAtlasLifecycleState,
      reason: 'not-needed',
      strategy: undefined,
      freshness,
      repoFingerprint: repoRevision?.token,
    };
  }

  const strategy = chooseAtlasRefreshStrategy(project, cached.atlas, repoRevision, cached.status);
  if (active) {
    return {
      projectId: project.id,
      cacheStatus: cached.status,
      stale: true,
      shouldRefresh: true,
      scheduled: false,
      deduplicated: active.revisionToken === repoRevision?.token,
      lifecycleState: 'generating' as ProjectAtlasLifecycleState,
      reason: 'refresh-in-progress',
      strategy: active.strategy,
      freshness,
      repoFingerprint: repoRevision?.token,
    };
  }

  if (!project.localPath) {
    return {
      projectId: project.id,
      cacheStatus: cached.status,
      stale: true,
      shouldRefresh: false,
      scheduled: false,
      deduplicated: false,
      lifecycleState: freshness.status === 'error' ? 'failed-retryable' as ProjectAtlasLifecycleState : 'missing' as ProjectAtlasLifecycleState,
      reason: 'missing-local-path',
      strategy,
      freshness,
      repoFingerprint: repoRevision?.token,
    };
  }

  activeAtlasRefreshes.set(project.id, { revisionToken: repoRevision?.token, strategy });
  const scheduler = input.scheduler ?? ((run: () => void) => setTimeout(run, 0));
  try {
    scheduler(() => {
      try {
        if (strategy === 'incremental' && repoRevision) {
          refreshProjectAtlasIncrementally(project, repoRevision, input.now);
        } else {
          rescanProjectAtlasSafely(project, {
            now: input.now,
            manualRescan: false,
            repoFingerprint: repoRevision?.token,
          });
        }
      } catch (error) {
        recordAtlasRefreshFailure(project.id, error, input.now);
      } finally {
        activeAtlasRefreshes.delete(project.id);
      }
    });
  } catch (error) {
    activeAtlasRefreshes.delete(project.id);
    const failedAtlas = recordAtlasRefreshFailure(project.id, error, input.now);
    return {
      projectId: project.id,
      cacheStatus: cached.status,
      stale: true,
      shouldRefresh: true,
      scheduled: false,
      deduplicated: false,
      lifecycleState: 'failed-retryable' as ProjectAtlasLifecycleState,
      reason: 'refresh-schedule-failed',
      strategy,
      freshness: failedAtlas.freshness,
      repoFingerprint: repoRevision?.token,
    };
  }

  return {
    projectId: project.id,
    cacheStatus: cached.status,
    stale: true,
    shouldRefresh: true,
    scheduled: true,
    deduplicated: false,
    lifecycleState: 'generating' as ProjectAtlasLifecycleState,
    reason: cached.status === 'missing' || freshness.status === 'not-generated' ? 'missing-atlas' : 'stale-atlas',
    strategy,
    freshness,
    repoFingerprint: repoRevision?.token,
  };
}

function recordAtlasRefreshFailure(projectId: string, error: unknown, now?: string) {
  const cached = readLatestAtlas(projectId);
  const message = error instanceof Error ? error.message : String(error);
  const atlas: ProjectAtlas = {
    ...cached.atlas,
    freshness: {
      ...cached.atlas.freshness,
      status: 'error',
      staleReason: 'refresh-failed',
      lastError: message,
      lastDailyOpenCheckedAt: now ?? cached.atlas.freshness.lastDailyOpenCheckedAt,
    },
  };
  saveLatestAtlas(atlas);
  return atlas;
}

function resolveAtlasRepoRevision(project: Project, explicit?: RepoRevision) {
  if (explicit) return explicit;
  if (!project.localPath) return undefined;
  try {
    return getRepoRevisionForRoot(project.localPath);
  } catch {
    return undefined;
  }
}

function chooseAtlasRefreshStrategy(
  project: Project,
  atlas: ProjectAtlas,
  repoRevision: RepoRevision | undefined,
  cacheStatus: string,
): ProjectAtlasRefreshStrategy {
  if (cacheStatus !== 'ok' || atlas.nodes.length === 0 || atlas.freshness.status === 'not-generated') return 'bootstrap';
  if (canRefreshAtlasIncrementally(project, atlas, repoRevision)) return 'incremental';
  return 'full';
}

function canRefreshAtlasIncrementally(project: Project, atlas: ProjectAtlas, repoRevision?: RepoRevision) {
  if (!project.localPath || !repoRevision || atlas.nodes.length === 0) return false;
  if (repoRevision.changedFiles.length === 0 || repoRevision.changedFiles.length > DEFAULT_INCREMENTAL_FILE_LIMIT) return false;
  return repoRevision.changedFiles.every((file) => {
    const status = file.status.toUpperCase();
    if (status.includes('D') || status.includes('R') || file.workingPath.includes(' -> ')) return false;
    return fs.existsSync(path.resolve(project.localPath as string, file.workingPath));
  });
}

function refreshProjectAtlasIncrementally(project: Project, repoRevision: RepoRevision, now?: string) {
  if (!project.localPath) throw new Error('Project has no localPath configured for Atlas scan');
  const cached = readLatestAtlas(project.id);
  if (cached.status !== 'ok' || cached.atlas.nodes.length === 0) {
    return rescanProjectAtlasSafely(project, { now, manualRescan: false, repoFingerprint: repoRevision.token });
  }
  const changedPaths = repoRevision.changedFiles.map((file) => file.workingPath.replace(/\\/g, '/'));
  const knownFilePaths = cached.atlas.nodes.map((node) => node.path).filter((value): value is string => Boolean(value));
  const partial = scanProjectForAtlas({
    projectId: project.id,
    root: project.localPath,
    paths: changedPaths,
    knownFilePaths,
  });
  if (partial.scanStats.errors.length > 0) {
    throw new Error(partial.scanStats.errors.join('; '));
  }
  if (partial.scanStats.scannedFileCount !== changedPaths.length) {
    throw new Error('Incremental Atlas refresh could not scan every changed file.');
  }

  const changedNodeIds = new Set(changedPaths.map((filePath) => `file:${filePath}`));
  const nodes = new Map(cached.atlas.nodes.map((node) => [node.id, node]));
  for (const node of partial.atlas.nodes) nodes.set(node.id, node);
  const edges = new Map(
    cached.atlas.edges
      .filter((edge) => !changedNodeIds.has(edge.source) && !(edge.kind === 'contains' && changedNodeIds.has(edge.target)))
      .map((edge) => [edge.id, edge]),
  );
  for (const edge of partial.atlas.edges) edges.set(edge.id, edge);

  const atlas: ProjectAtlas = {
    ...cached.atlas,
    nodes: Array.from(nodes.values()).sort((left, right) => left.id.localeCompare(right.id)),
    edges: Array.from(edges.values()).sort((left, right) => left.id.localeCompare(right.id)),
    freshness: {
      ...cached.atlas.freshness,
      generatedAt: now ?? new Date().toISOString(),
      repoFingerprint: repoRevision.token,
      scanMode: 'automatic',
      status: 'fresh',
      staleReason: undefined,
      lastError: undefined,
    },
  };
  saveLatestAtlas(atlas);
  return { ok: true, projectId: project.id, atlas, scanStats: partial.scanStats, status: getProjectAtlasStatus(project.id) };
}

export function getProjectAtlasForApi(project: Project, input: ProjectAtlasApiInput = {}) {
  const mode = input.mode ?? 'compact';
  const limit = normalizeAtlasLimit(input.limit, mode === 'full' ? 500 : DEFAULT_ATLAS_OUTPUT_LIMIT);
  const refreshStatus = maybeRefreshAtlasOnProjectOpen(project);
  const cached = readLatestAtlas(project.id);
  const atlas = cached.status === 'ok' ? getManagedProjectAtlas(cached.atlas) : cached.atlas;
  const status = getProjectAtlasStatus(project.id);
  const base = {
    mode,
    projectId: project.id,
    projectName: project.name,
    stale: status.stale,
    generatedAt: status.generatedAt,
    freshness: atlas.freshness,
    cacheStatus: cached.status,
    lifecycleState: refreshStatus.lifecycleState,
    refreshStatus,
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
    const taskImpact = buildTaskFocusedAtlasImpact(atlas, {
      title: input.taskTitle || input.taskId,
      targetFiles: input.targetFiles?.length ? input.targetFiles : matches
        .map((id) => atlas.nodes.find((node) => node.id === id)?.path)
        .filter(Boolean) as string[],
      repoContext: input.query,
    });
    return withAtlasPromptTemplate({
      ...base,
      query,
      matchedNodeIds: matches,
      selectedContext: selectedNodeId ? buildNodeContext(atlas, selectedNodeId) : '',
      nodes: atlas.nodes.filter((node) => matches.includes(node.id)).slice(0, limit),
      edges: atlas.edges.filter((edge) => matches.includes(edge.source) || matches.includes(edge.target)).slice(0, limit),
      impact: taskImpact,
    }, atlas, { ...input, selectedNodeId: input.selectedNodeId ?? selectedNodeId });
  }

  if (mode === 'diff-impact') {
    const changedFiles = input.changedFiles?.length
      ? input.changedFiles
      : project.localPath
        ? getChangedGitFilesForRoot(project.localPath).map((file) => file.path)
        : [];
    return withAtlasPromptTemplate({
      ...base,
      format: 'impact',
      impact: buildAtlasDiffImpact(atlas, { changedFiles }),
    }, atlas, input);
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
  const atlas = result.atlas;
  saveLatestAtlas(atlas);
  return {
    projectId: project.id,
    atlas,
    scanStats: result.scanStats,
    status: getProjectAtlasStatus(project.id),
  };
}

export function rescanProjectAtlasSafely(project: Project, input: { now?: string; manualRescan?: boolean; repoFingerprint?: string } = {}) {
  try {
    const result = rescanProjectAtlas(project);
    const atlas = {
      ...result.atlas,
      freshness: {
        ...result.atlas.freshness,
        generatedAt: input.now ?? result.atlas.freshness.generatedAt ?? new Date().toISOString(),
        repoFingerprint: input.repoFingerprint ?? result.atlas.freshness.repoFingerprint,
        scanMode: input.manualRescan === false ? 'automatic' as const : 'manual' as const,
        status: 'fresh' as const,
        lastError: undefined,
      },
    };
    saveLatestAtlas(atlas);
    return { ok: true, ...result, atlas, status: getProjectAtlasStatus(project.id) };
  } catch (error) {
    const cached = readLatestAtlas(project.id);
    const atlas = {
      ...cached.atlas,
      freshness: {
        ...cached.atlas.freshness,
        status: 'error' as const,
        lastError: error instanceof Error ? error.message : String(error),
        lastDailyOpenCheckedAt: input.now ?? cached.atlas.freshness.lastDailyOpenCheckedAt,
      },
    };
    saveLatestAtlas(atlas);
    return {
      ok: false,
      projectId: project.id,
      atlas,
      status: getProjectAtlasStatus(project.id),
      error: atlas.freshness.lastError,
    };
  }
}

export function applyProjectAtlasAgentUpdate(project: Project, patch: unknown, options: ApplyProjectAtlasAgentUpdateOptions = {}) {
  return applyProjectAtlasAgentUpdatePatch(project, patch, options);
}

export function getProjectAtlasStatus(projectId: string) {
  const cached = readLatestAtlas(projectId);
  const freshness = cached.atlas.freshness;
  const authoring = cached.atlas.authoring;
  const stale = isAtlasStale(freshness);
  const active = activeAtlasRefreshes.get(projectId);
  const lifecycleState: ProjectAtlasLifecycleState = active
    ? 'generating'
    : cached.status !== 'ok' || freshness.status === 'not-generated'
      ? 'missing'
      : freshness.status === 'error'
        ? 'failed-retryable'
        : stale
          ? 'stale'
          : 'fresh';
  return {
    projectId,
    cacheStatus: cached.status,
    stale,
    lifecycleState,
    refreshStrategy: active?.strategy,
    retryable: lifecycleState === 'failed-retryable',
    generatedAt: freshness.generatedAt,
    freshness,
    nodeCount: cached.atlas.nodes.length,
    edgeCount: cached.atlas.edges.length,
    domainCount: cached.atlas.domains.length,
    lastError: cached.error ?? freshness.lastError,
    warnings: authoring?.warnings ?? [],
    authoring: {
      state: authoring ? 'chatgpt-authored' : 'missing-authored-atlas',
      updatedAt: authoring?.updatedAt,
      provenance: authoring?.provenance,
      coverage: authoring?.coverage,
      groupingRationale: authoring?.groupingRationale,
      evidenceCount: authoring?.evidence.length ?? 0,
      readOrderCount: authoring?.readOrder.length ?? 0,
      warningCount: authoring?.warnings.length ?? 0,
    },
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
  const cachedAtlas = readLatestAtlas(project.id);
  const fullAtlas = cachedAtlas.status === 'ok' ? getManagedProjectAtlas(cachedAtlas.atlas) : cachedAtlas.atlas;
  const impact = buildTaskFocusedAtlasImpact(fullAtlas, task);
  const recommendedReadOrder = impact.readOrder.length
    ? impact.readOrder.map((item) => item.path || item.label)
    : readOrder;

  return {
    included: true,
    reason: decision.reason,
    mode: 'task-focused',
    stale: atlas.stale,
    generatedAt: atlas.generatedAt,
    matchedNodeIds: atlas.matchedNodeIds,
    recommendedReadOrder,
    impact: {
      compactSummary: impact.compactSummary,
      warnings: impact.warnings,
      relatedTests: impact.relatedTests.map((node) => node.path || node.label),
      mermaid: impact.mermaid,
    },
    markdown: [
      '## Project Atlas Task Context',
      '',
      `Reason: ${decision.reason}`,
      `Freshness: ${atlas.freshness?.status ?? 'unknown'}${atlas.generatedAt ? ` (${atlas.generatedAt})` : ''}`,
      '',
      '### Recommended Read Order',
      ...(recommendedReadOrder.length ? recommendedReadOrder.map((entry: string) => `- ${entry}`) : ['- No focused Atlas nodes matched; use repo context bundle before broad reads.']),
      impact.warnings.length ? ['', '### Atlas Impact Warnings', ...impact.warnings.map((warning) => `- ${warning.message}`)] : undefined,
      impact.relatedTests.length ? ['', '### Related Tests', ...impact.relatedTests.map((node) => `- ${node.path || node.label}`)] : undefined,
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
