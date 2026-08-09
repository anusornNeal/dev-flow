import type { AppState } from '../types';
import { getRepoInspectionIndex } from '../services/repoInspectionIndexService.js';
import { getProjectAtlasForApi } from '../services/projectAtlasService.js';
import { findProjectByIdentifier } from '../services/taskService.js';
import {
  buildWorkDecomposition,
  type BuildWorkDecompositionInput,
  type DecompositionSessionEvidence,
} from '../services/workDecompositionService.js';

type DecompositionDeps = {
  findProject: typeof findProjectByIdentifier;
  getRepoIndex: typeof getRepoInspectionIndex;
  getAtlas: typeof getProjectAtlasForApi;
};

const defaultDeps: DecompositionDeps = {
  findProject: findProjectByIdentifier,
  getRepoIndex: getRepoInspectionIndex,
  getAtlas: getProjectAtlasForApi,
};

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTargetFiles(value: unknown) {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(value.map((item) => cleanText(item).replace(/\\/g, '/')).filter(Boolean))).sort();
}

function buildQuery(args: Record<string, any>) {
  return [
    cleanText(args.title),
    cleanText(args.description),
    cleanText(args.reasoning),
    cleanText(args.repoContext),
    ...normalizeTargetFiles(args.targetFiles),
  ].filter(Boolean).join(' ').slice(0, 4000);
}

function atlasEvidenceFrom(result: any, fallbackWarning?: string) {
  if (!result) {
    return fallbackWarning ? { stale: true, warnings: [fallbackWarning] } : undefined;
  }
  return {
    stale: result.stale === true,
    matchedNodeIds: Array.isArray(result.matchedNodeIds) ? result.matchedNodeIds : [],
    relatedTests: Array.isArray(result.impact?.relatedTests) ? result.impact.relatedTests : [],
    warnings: [
      ...(Array.isArray(result.impact?.warnings) ? result.impact.warnings : []),
      ...(fallbackWarning ? [fallbackWarning] : []),
    ],
    recommendedReadOrder: Array.isArray(result.recommendedReadOrder) ? result.recommendedReadOrder : [],
  };
}

export function buildWorkDecompositionUseCase(
  state: AppState,
  args: Record<string, any>,
  deps: DecompositionDeps = defaultDeps,
) {
  const project = deps.findProject(state, {
    projectId: cleanText(args.projectId) || undefined,
    projectName: cleanText(args.projectName) || undefined,
    repo: cleanText(args.repo) || undefined,
    repoUrl: cleanText(args.repoUrl) || undefined,
    localPath: cleanText(args.localPath) || undefined,
  });
  if (!project) throw new Error('Project could not be resolved for work decomposition.');

  const query = buildQuery(args);
  const repoIndex = deps.getRepoIndex(state, {
    ...args,
    projectId: project.id,
    q: query,
    limit: Number.isFinite(Number(args.limit)) ? Math.max(4, Math.min(30, Number(args.limit))) : 20,
  });

  let atlas: any;
  let atlasError: string | undefined;
  try {
    atlas = deps.getAtlas(project, {
      mode: 'task-focused',
      query,
      taskTitle: cleanText(args.title),
      targetFiles: normalizeTargetFiles(args.targetFiles),
      limit: Number.isFinite(Number(args.atlasLimit)) ? Math.max(4, Math.min(80, Number(args.atlasLimit))) : 30,
    });
  } catch (error) {
    atlasError = `Atlas unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }

  const repoRevision = cleanText(repoIndex?.repoRevision)
    || cleanText(args.sessionEvidence?.repoRevision)
    || undefined;
  const sessionEvidence = args.sessionEvidence && typeof args.sessionEvidence === 'object'
    ? args.sessionEvidence as DecompositionSessionEvidence
    : undefined;
  const decompositionInput: BuildWorkDecompositionInput = {
    title: cleanText(args.title) || 'Untitled implementation work',
    description: cleanText(args.description),
    reasoning: cleanText(args.reasoning),
    repoContext: cleanText(args.repoContext),
    targetFiles: normalizeTargetFiles(args.targetFiles),
    verification: cleanText(args.verification),
    repoEvidence: {
      repoRevision,
      matches: Array.isArray(repoIndex?.matches) ? repoIndex.matches : [],
    },
    atlasEvidence: atlasEvidenceFrom(atlas, atlasError),
    sessionEvidence,
  };
  const decomposition = buildWorkDecomposition(decompositionInput);

  return {
    project: { id: project.id, name: project.name },
    query,
    decomposition,
    evidence: {
      repoRevision,
      repoMatchCount: decompositionInput.repoEvidence?.matches?.length || 0,
      repoLineageToken: repoIndex?.cache?.lineageToken,
      atlasAvailable: Boolean(atlas),
      atlasStale: atlas?.stale === true,
      atlasMatchedNodeCount: Array.isArray(atlas?.matchedNodeIds) ? atlas.matchedNodeIds.length : 0,
      sessionEvidenceUsed: Boolean(sessionEvidence),
    },
  };
}
