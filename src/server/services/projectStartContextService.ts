import fs from 'fs';
import path from 'path';
import { performance as nodePerformance } from 'node:perf_hooks';
import type { AppState } from '../types';
import { findProjectByIdentifier } from './taskService';
import { createApiError } from './api';
import { listLocalFiles, readLocalFile, readResolvedLocalFile, resolveProjectRoot, searchLocalFiles } from './localFileService';
import { getGitDiff } from './gitService';
import { getRepoInspectionIndex } from './repoInspectionIndexService';
import { registerRepoCacheInvalidator } from './repoCacheInvalidationService';
import { buildRepoEvidenceIdentity, getRepoRevisionForRoot, type RepoRevision } from './repoRevisionService';
import { contextGovernorInputFromArgs, planContextGovernor } from './contextGovernorService';
import { ADAPTIVE_SOURCE_DISCLOSURE_POLICY } from './contextBudgetPlannerService';
import { ensureRepoChangeWatcher } from './workspaceChangeWatcherService';
import { maybeRefreshAtlasOnProjectOpen } from './projectAtlasService.js';

const DEVFLOW_PROJECT_INSTRUCTIONS_PATH = '.devflow/agents.md';
const HINT_FILES = ['AGENTS.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'gradlew.bat', 'build.gradle', 'settings.gradle'];

function isRegularFile(filePath: string) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function clearRepoContextBundleCache(_root?: string) {
  // getRepoContextBundle is intentionally assembled from fresh git/snippets plus the repo index cache.
  // Register a no-op invalidator so workflow health can report bundle cache readiness consistently.
  return 0;
}

registerRepoCacheInvalidator('repo-context-bundle', clearRepoContextBundleCache);

const MAX_REPO_CONTEXT_BUNDLE_PERFORMANCE_RECORDS = 500;
const DEFAULT_REPO_CONTEXT_BUNDLE_PERFORMANCE_WINDOW_MS = 10 * 60 * 1000;

type RepoIndexCacheState = 'cold' | 'warm';
type RepoContextBundlePhaseTimings = {
  startContextMs: number;
  repoIndexMs: number;
  snippetReadMs: number;
  snippetReadCount: number;
  diffMs: number;
  responseAssemblyMs: number;
};
type RepoContextBundlePerformanceRecord = {
  repoIndexCacheState: RepoIndexCacheState;
  totalMs: number;
  phases: RepoContextBundlePhaseTimings;
  timestamp: number;
};

const repoContextBundlePerformanceRecords: RepoContextBundlePerformanceRecord[] = [];

function roundDuration(value: number) {
  return Math.round(Math.max(0, value) * 100) / 100;
}

function performancePercentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function dominantRepoContextPhase(phases: RepoContextBundlePhaseTimings) {
  const candidates = [
    ['startContext', phases.startContextMs],
    ['repoIndex', phases.repoIndexMs],
    ['snippetRead', phases.snippetReadMs],
    ['diff', phases.diffMs],
    ['responseAssembly', phases.responseAssemblyMs],
  ] as const;
  return [...candidates].sort((left, right) => right[1] - left[1])[0][0];
}

export function clearRepoContextBundlePerformanceRecords() {
  repoContextBundlePerformanceRecords.length = 0;
}

export function recordRepoContextBundlePerformance(input: {
  repoIndexCacheState: RepoIndexCacheState;
  totalMs: number;
  phases: RepoContextBundlePhaseTimings;
  timestamp?: number;
}) {
  const numeric = (value: unknown) => roundDuration(Number.isFinite(Number(value)) ? Number(value) : 0);
  const record: RepoContextBundlePerformanceRecord = {
    repoIndexCacheState: input.repoIndexCacheState === 'warm' ? 'warm' : 'cold',
    totalMs: numeric(input.totalMs),
    phases: {
      startContextMs: numeric(input.phases?.startContextMs),
      repoIndexMs: numeric(input.phases?.repoIndexMs),
      snippetReadMs: numeric(input.phases?.snippetReadMs),
      snippetReadCount: Math.max(0, Math.floor(Number(input.phases?.snippetReadCount) || 0)),
      diffMs: numeric(input.phases?.diffMs),
      responseAssemblyMs: numeric(input.phases?.responseAssemblyMs),
    },
    timestamp: Number.isFinite(Number(input.timestamp)) ? Number(input.timestamp) : Date.now(),
  };
  repoContextBundlePerformanceRecords.push(record);
  if (repoContextBundlePerformanceRecords.length > MAX_REPO_CONTEXT_BUNDLE_PERFORMANCE_RECORDS) {
    repoContextBundlePerformanceRecords.splice(0, repoContextBundlePerformanceRecords.length - MAX_REPO_CONTEXT_BUNDLE_PERFORMANCE_RECORDS);
  }
  return record;
}

function summarizeRepoContextBundlePerformance(records: RepoContextBundlePerformanceRecord[], repoIndexCacheState: RepoIndexCacheState) {
  const phase = (key: keyof Omit<RepoContextBundlePhaseTimings, 'snippetReadCount'>) => {
    const values = records.map((record) => record.phases[key]);
    return {
      p50Ms: performancePercentile(values, 50),
      p95Ms: performancePercentile(values, 95),
    };
  };
  const phases = {
    startContext: phase('startContextMs'),
    repoIndex: phase('repoIndexMs'),
    snippetRead: {
      ...phase('snippetReadMs'),
      count: records.reduce((sum, record) => sum + record.phases.snippetReadCount, 0),
    },
    diff: phase('diffMs'),
    responseAssembly: phase('responseAssemblyMs'),
  };
  const phaseCandidates = [
    ['startContext', phases.startContext.p95Ms],
    ['repoIndex', phases.repoIndex.p95Ms],
    ['snippetRead', phases.snippetRead.p95Ms],
    ['diff', phases.diff.p95Ms],
    ['responseAssembly', phases.responseAssembly.p95Ms],
  ] as const;
  const dominant = [...phaseCandidates].sort((left, right) => right[1] - left[1])[0];
  const totals = records.map((record) => record.totalMs);
  return {
    repoIndexCacheState,
    count: records.length,
    p50TotalMs: performancePercentile(totals, 50),
    p95TotalMs: performancePercentile(totals, 95),
    dominantPhase: dominant[0],
    dominantPhaseP95Ms: dominant[1],
    phases,
  };
}

export function getRepoContextBundlePerformanceSummary(options: { now?: number; windowMs?: number } = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Number.isFinite(Number(options.windowMs))
    ? Math.max(1, Number(options.windowMs))
    : DEFAULT_REPO_CONTEXT_BUNDLE_PERFORMANCE_WINDOW_MS;
  const recent = repoContextBundlePerformanceRecords.filter((record) => record.timestamp >= now - windowMs && record.timestamp <= now);
  return {
    windowMs,
    cold: summarizeRepoContextBundlePerformance(recent.filter((record) => record.repoIndexCacheState === 'cold'), 'cold'),
    warm: summarizeRepoContextBundlePerformance(recent.filter((record) => record.repoIndexCacheState === 'warm'), 'warm'),
  };
}

function resolveProject(state: AppState, args: Record<string, any>) {
  const project = findProjectByIdentifier(state, {
    projectId: typeof args.projectId === 'string' ? args.projectId.trim() : undefined,
    projectName: typeof args.projectName === 'string' ? args.projectName.trim() : undefined,
    repo: typeof args.repo === 'string' ? args.repo.trim() : undefined,
    repoUrl: typeof args.repoUrl === 'string' ? args.repoUrl.trim() : undefined,
    localPath: typeof args.localPath === 'string' ? args.localPath.trim() : undefined,
  });
  if (!project) {
    throw createApiError(404, 'PROJECT_NOT_FOUND', 'Project could not be resolved for start context.');
  }
  return project;
}

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseBoundedList(value: unknown, max = 8) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(raw.map((entry) => String(entry || '').trim()).filter(Boolean))].slice(0, max);
}

function normalizeToolPath(value: unknown) {
  return String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizeMissingContextRequest(args: Record<string, any>) {
  const requested = args.contextSufficient === false || String(args.contextSufficient || '').toLowerCase() === 'false';
  let remaining = 24;
  const take = (value: unknown, transform?: (entry: string) => string) => {
    const entries = parseBoundedList(value, Math.min(8, remaining));
    remaining -= entries.length;
    return transform ? entries.map(transform).filter(Boolean) : entries;
  };
  const files = take(args.missingFiles, normalizeToolPath);
  const symbols = take(args.missingSymbols);
  const tests = take(args.missingTests, normalizeToolPath);
  const relationships = take(args.missingRelationships);
  const total = files.length + symbols.length + tests.length + relationships.length;
  return {
    requested,
    files,
    symbols,
    tests,
    relationships,
    total,
    specific: requested && total > 0,
  };
}

export function getMissingContextDelta(state: AppState, args: Record<string, any>) {
  const request = normalizeMissingContextRequest(args);
  if (!request.requested) return { request, status: 'not-requested' as const, snippets: [], relationships: [], returnedBytes: 0, estimatedTokens: 0 };
  if (!request.specific) {
    return {
      request,
      status: 'specific-evidence-required' as const,
      snippets: [],
      relationships: [],
      returnedBytes: 0,
      estimatedTokens: 0,
    };
  }

  const project = resolveProject(state, args);
  const snippets: any[] = [];
  const relationshipMatches: any[] = [];
  const seen = new Set<string>();
  const addSnippet = (kind: 'file' | 'test' | 'symbol', label: string, filePath: string, startLine: number, endLine: number) => {
    if (snippets.length >= 8) return;
    const normalizedPath = normalizeToolPath(filePath);
    const rangeKey = `${kind}:${label}:${normalizedPath}:${startLine}:${endLine}`;
    if (seen.has(rangeKey)) return;
    const snippet = readLocalFile(state, {
      ...args,
      projectId: project.id,
      filePath: normalizedPath,
      startLine,
      endLine,
      maxBytes: 8_000,
    });
    seen.add(rangeKey);
    snippets.push({
      kind,
      label,
      path: normalizedPath,
      startLine: snippet.startLine,
      endLine: snippet.endLine,
      totalLines: snippet.totalLines,
      content: snippet.content,
      truncated: snippet.truncated,
      returnedBytes: Buffer.byteLength(String(snippet.content || ''), 'utf8'),
      revision: snippet.revision,
      fileRevision: snippet.fileRevision,
      evidenceKey: `${kind}:${label}:${normalizedPath}:${snippet.startLine}:${snippet.endLine}`,
      evidenceReasons: [`missing-${kind}`],
    });
  };

  for (const filePath of request.files) addSnippet('file', filePath, filePath, 1, 100);
  for (const filePath of request.tests) addSnippet('test', filePath, filePath, 1, 100);

  for (const symbol of request.symbols) {
    if (snippets.length >= 8) break;
    const search = searchLocalFiles(state, {
      ...args,
      projectId: project.id,
      query: escapeRegex(symbol),
      q: escapeRegex(symbol),
      path: args.path || '.',
      limit: 3,
    });
    const match = (search.matches || []).find((entry: any) => !/(?:^|[\\/])(?:tests?|__tests__)(?:[\\/]|$)|(?:\.test\.|\.spec\.)/i.test(String(entry.path || '')))
      || (search.matches || [])[0];
    if (match?.path && Number.isFinite(Number(match.line))) {
      const line = Math.max(1, Number(match.line));
      addSnippet('symbol', symbol, match.path, Math.max(1, line - 20), line + 40);
    }
  }

  for (const relationship of request.relationships) {
    if (relationshipMatches.length >= 8) break;
    const index = getRepoInspectionIndex(state, {
      ...args,
      projectId: project.id,
      q: relationship,
      limit: 4,
    });
    for (const match of index.matches || []) {
      if (relationshipMatches.length >= 8) break;
      relationshipMatches.push({
        relationship,
        path: match.path,
        score: match.score,
        symbols: match.symbols,
        imports: match.imports,
        evidenceKey: `relationship:${relationship}:${normalizeToolPath(match.path)}`,
        evidenceReasons: ['missing-relationship'],
      });
    }
  }

  const returnedBytes = snippets.reduce((total, snippet) => total + Number(snippet.returnedBytes || 0), 0)
    + Buffer.byteLength(JSON.stringify(relationshipMatches), 'utf8');
  return {
    request,
    status: snippets.length > 0 || relationshipMatches.length > 0 ? 'resolved' as const : 'unresolved' as const,
    snippets,
    relationships: relationshipMatches,
    returnedBytes,
    estimatedTokens: Math.ceil(returnedBytes / 4),
    budget: {
      maxRequestItems: 24,
      maxItemsPerCategory: 8,
      maxSnippets: 8,
      maxSnippetBytes: 8_000,
      relationshipLimit: 8,
    },
  };
}

function buildProjectStartContext(state: AppState, args: Record<string, any>, captureTrustedRevision?: (revision: RepoRevision) => void) {
  const project = resolveProject(state, args);
  const root = project.localPath ? resolveProjectRoot(state, { ...args, projectId: project.id }) : '';
  const changeWatcher = root ? ensureRepoChangeWatcher(root) : { active: false, degraded: false };
  const topLevel = root
    ? listLocalFiles(state, { ...args, projectId: project.id, path: '.', recursive: false, limit: args.limit || 80 })
    : { count: 0, files: [] };

  let git: any = { available: false };
  let repoRevision: string | undefined;
  if (root) {
    try {
      const revision = getRepoRevisionForRoot(root);
      captureTrustedRevision?.(revision);
      repoRevision = revision.token;
      git = {
        available: true,
        branch: revision.branch,
        changedFiles: revision.changedFiles.length,
        files: revision.changedFiles.slice(0, 25).map((entry) => ({ path: entry.path, staged: entry.staged, status: entry.status })),
        repoRevision: revision.token,
        head: revision.head,
      };
    } catch (error: any) {
      git = { available: false, reason: error?.message || 'Git context unavailable.' };
    }
  }

  const atlasRefresh = maybeRefreshAtlasOnProjectOpen(project, {
    now: typeof args.atlasNow === 'string' ? args.atlasNow : undefined,
    scheduler: typeof args.atlasScheduler === 'function' ? args.atlasScheduler : undefined,
  });
  const projectAtlas = {
    projectId: atlasRefresh.projectId,
    cacheStatus: atlasRefresh.cacheStatus,
    lifecycleState: atlasRefresh.lifecycleState,
    stale: atlasRefresh.stale,
    shouldRefresh: atlasRefresh.shouldRefresh,
    scheduled: atlasRefresh.scheduled,
    deduplicated: atlasRefresh.deduplicated,
    strategy: atlasRefresh.strategy,
    reason: atlasRefresh.reason,
    lastError: atlasRefresh.freshness?.lastError,
  };

  const devFlowProjectInstructionsPresent = Boolean(
    project.localPath
    && isRegularFile(path.join(project.localPath, '.devflow', 'agents.md')),
  );
  const genericPresentHints = root
    ? HINT_FILES.filter((fileName) => isRegularFile(path.join(root, fileName)))
    : [];
  const presentHints = [
    ...(devFlowProjectInstructionsPresent ? [DEVFLOW_PROJECT_INSTRUCTIONS_PATH] : []),
    ...genericPresentHints,
  ];

  return {
    project: {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      localPath: project.localPath,
      taskIdPrefix: project.taskIdPrefix,
      gitWorkflowPolicy: project.gitWorkflowPolicy,
      workspaceId: typeof args.workspaceId === 'string' ? args.workspaceId : undefined,
      isolatedSession: Boolean(args.sessionId || args.workspaceId),
    },
    git,
    repoRevision,
    changeWatcher,
    projectAtlas,
    files: topLevel,
    hints: {
      present: presentHints,
      recommendedReads: presentHints.filter((fileName) => [DEVFLOW_PROJECT_INSTRUCTIONS_PATH, 'AGENTS.md', 'README.md', 'package.json'].includes(fileName)),
    },
    recommendedNextTools: [
      'get_skill_router',
      'read_local_file',
      'search_local_files',
      'list_tasks',
      'get_agent_task_context',
    ],
  };
}

export function getProjectStartContext(state: AppState, args: Record<string, any>) {
  return buildProjectStartContext(state, args);
}

function formatSymbolSummary(symbols: unknown, maxSymbols = 8) {
  if (!Array.isArray(symbols) || symbols.length === 0) return '';
  return symbols.slice(0, maxSymbols).join(', ');
}

export function getRepoReadSnapshot(state: AppState, args: Record<string, any>) {
  const project = resolveProject(state, args);
  const query = typeof args.q === 'string' ? args.q : typeof args.query === 'string' ? args.query : '';
  const indexLimit = parsePositiveInt(args.limit, 10, 30);
  const start = getProjectStartContext(state, { ...args, projectId: project.id, limit: args.topLevelLimit || 30 });
  const index = getRepoInspectionIndex(state, {
    ...args,
    projectId: project.id,
    q: query,
    path: args.path,
    limit: indexLimit,
    includeIgnored: args.includeIgnored,
  });

  const likelyFiles = (index.matches || []).slice(0, indexLimit).map((match: any) => {
    let metadata: any = undefined;
    try {
      const fileMetadata = readLocalFile(state, {
        ...args,
        projectId: project.id,
        filePath: match.path,
        mode: 'metadata',
      });
      metadata = {
        bytes: fileMetadata.bytes,
        totalLines: fileMetadata.totalLines,
        modifiedAt: fileMetadata.modifiedAt,
        revision: fileMetadata.revision,
      };
    } catch (error: any) {
      metadata = { error: error?.message || 'Metadata unavailable.' };
    }

    return {
      path: match.path,
      extension: match.extension,
      score: match.score,
      symbols: match.symbols,
      metadata,
    };
  });

  const changedFiles = Array.isArray(start.git?.files) ? start.git.files : [];
  const branch = start.git?.branch || 'unknown';
  const gitLine = start.git?.available
    ? `Git: branch ${branch}, ${start.git.changedFiles || 0} changed file(s).`
    : `Git: unavailable${start.git?.reason ? ` (${start.git.reason})` : ''}.`;
  const likelyLines = likelyFiles.length
    ? likelyFiles.slice(0, 8).map((file: any, index) => {
      const symbols = formatSymbolSummary(file.symbols);
      return `${index + 1}. ${file.path}${symbols ? ` [${symbols}]` : ''}`;
    })
    : ['No likely files matched the query.'];
  const summary = [
    `Project: ${start.project.name} (${start.project.id})`,
    gitLine,
    `Query: ${query || '(none)'}`,
    `Likely files: ${likelyFiles.length}`,
    ...likelyLines,
    changedFiles.length ? `Changed files: ${changedFiles.map((file: any) => file.path).join(', ')}` : 'Changed files: none',
    `Next: use read_file_snippets_batch for focused file ranges or get_repo_context_bundle when snippet content/diff is needed.`,
  ].join('\n');

  return {
    project: start.project,
    query,
    repoRevision: start.repoRevision,
    path: typeof args.path === 'string' ? args.path : '.',
    projectAtlas: start.projectAtlas,
    git: {
      available: start.git?.available === true,
      branch: start.git?.branch,
      changedFiles: start.git?.changedFiles || 0,
      files: changedFiles,
    },
    hints: start.hints,
    index: {
      cache: index.cache,
      generatedAt: index.generatedAt,
      metadata: index.metadata,
      count: index.matches?.length || 0,
    },
    likelyFiles,
    summary,
    recommendedNextTools: [
      'read_file_snippets_batch',
      'get_repo_context_bundle',
      'search_local_files',
      'run_project_command',
    ],
  };
}

function serializedContextBytes(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function compactContextEvidenceReference(entry: any) {
  return {
    path: entry.path,
    ...(entry.extension ? { extension: entry.extension } : {}),
    ...(Number.isFinite(Number(entry.score)) ? { score: entry.score } : {}),
    ...(entry.explicitTarget === true ? { explicitTarget: true } : {}),
    rank: entry.rank,
    isTest: entry.isTest === true,
    selected: entry.selected === true,
  };
}

function stabilizeResponseBudgetBytes(response: any) {
  const meta = response?.contextPlan?.responseBudget;
  if (!meta) return serializedContextBytes(response);
  let bytes = serializedContextBytes(response);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (meta.returnedBytes === bytes) break;
    meta.returnedBytes = bytes;
    bytes = serializedContextBytes(response);
  }
  meta.returnedBytes = bytes;
  return serializedContextBytes(response);
}

function applyAggregateContextBudget(response: any, budgetBytes: number) {
  const estimatedBytesBeforeCompaction = serializedContextBytes(response);
  const omitted = {
    indexMatchDetails: 0,
    evidenceDetails: 0,
    evidenceEntries: 0,
    snippetContentBytes: 0,
    diffBytes: 0,
    gitFileDetails: 0,
  };
  const fullIndexMatches = Array.isArray(response.index?.matches) ? response.index.matches : [];
  response.index.matches = fullIndexMatches.map((entry: any) => compactContextEvidenceReference(entry));
  omitted.indexMatchDetails = fullIndexMatches.filter((entry: any) => entry.symbols?.length || entry.imports?.length || entry.reasons?.length).length;

  response.contextPlan.responseBudget = {
    budgetBytes,
    returnedBytes: 0,
    estimatedBytesBeforeCompaction,
    budgetExhausted: estimatedBytesBeforeCompaction > budgetBytes,
    omitted,
  };

  const decisionBudget = Math.max(1, budgetBytes - 256);
  const currentBytes = () => stabilizeResponseBudgetBytes(response);
  const compactEvidenceRank = (rank: 'optional' | 'should' | 'must') => {
    response.contextPlan.evidence = (response.contextPlan.evidence || []).map((entry: any) => {
      if (entry.rank !== rank) return entry;
      if (!entry.symbols?.length && !entry.imports?.length && !entry.reasons?.length) return entry;
      omitted.evidenceDetails += 1;
      return compactContextEvidenceReference(entry);
    });
  };

  if (currentBytes() > decisionBudget) compactEvidenceRank('optional');
  if (currentBytes() > decisionBudget) compactEvidenceRank('should');
  if (currentBytes() > decisionBudget) compactEvidenceRank('must');

  if (currentBytes() > decisionBudget && Array.isArray(response.snippets)) {
    for (let index = response.snippets.length - 1; index >= 0 && currentBytes() > decisionBudget; index -= 1) {
      const snippet = response.snippets[index];
      if (snippet?.rank === 'must' || typeof snippet?.content !== 'string') continue;
      omitted.snippetContentBytes += Buffer.byteLength(snippet.content, 'utf8');
      response.snippets.splice(index, 1);
    }
  }

  if (currentBytes() > decisionBudget && Array.isArray(response.snippets)) {
    for (const snippet of response.snippets) {
      if (currentBytes() <= decisionBudget || typeof snippet?.content !== 'string') break;
      const originalBytes = Buffer.byteLength(snippet.content, 'utf8');
      const keepBytes = Math.max(0, Math.min(originalBytes, 1024));
      if (keepBytes >= originalBytes) continue;
      snippet.content = Buffer.from(snippet.content, 'utf8').subarray(0, keepBytes).toString('utf8');
      snippet.aggregateTruncated = true;
      snippet.originalReturnedBytes = snippet.returnedBytes ?? originalBytes;
      snippet.returnedBytes = Buffer.byteLength(snippet.content, 'utf8');
      omitted.snippetContentBytes += Math.max(0, originalBytes - snippet.returnedBytes);
    }
  }

  if (currentBytes() > decisionBudget && response.diff?.diff) {
    omitted.diffBytes += Buffer.byteLength(String(response.diff.diff), 'utf8');
    response.diff = { ...response.diff, diff: '', truncated: true, returnedBytes: 0 };
  }

  if (currentBytes() > decisionBudget && Array.isArray(response.contextPlan.evidence)) {
    for (let index = response.contextPlan.evidence.length - 1; index >= 0 && currentBytes() > decisionBudget; index -= 1) {
      const entry = response.contextPlan.evidence[index];
      if (entry?.rank === 'must') continue;
      response.contextPlan.evidence.splice(index, 1);
      omitted.evidenceEntries += 1;
    }
  }

  if (currentBytes() > decisionBudget && Array.isArray(response.index?.matches)) {
    const mustPaths = new Set((response.contextPlan.evidence || []).filter((entry: any) => entry.rank === 'must').map((entry: any) => String(entry.path)));
    response.index.matches = response.index.matches.filter((entry: any) => mustPaths.has(String(entry.path)));
  }

  if (currentBytes() > decisionBudget && Array.isArray(response.git?.files) && response.git.files.length > 20) {
    omitted.gitFileDetails += response.git.files.length - 20;
    response.git = { ...response.git, files: response.git.files.slice(0, 20).map((entry: any) => ({ path: entry.path || entry.workingPath, status: entry.status })) };
  }

  stabilizeResponseBudgetBytes(response);
  return response;
}

export function getRepoContextBundle(state: AppState, args: Record<string, any>) {
  const bundleStartedAt = nodePerformance.now();
  const project = resolveProject(state, args);
  const query = typeof args.q === 'string' ? args.q : typeof args.query === 'string' ? args.query : '';
  const targetFiles = Array.isArray(args.targetFiles)
    ? args.targetFiles.map(String).map((value) => value.trim()).filter(Boolean)
    : typeof args.targetFiles === 'string'
      ? args.targetFiles.split(',').map((value: string) => value.trim()).filter(Boolean)
      : [];
  const startContextStartedAt = nodePerformance.now();
  let trustedRepoRevision: RepoRevision | undefined;
  const start = buildProjectStartContext(
    state,
    { ...args, projectId: project.id, limit: args.topLevelLimit || 40 },
    (revision) => { trustedRepoRevision = revision; },
  );
  const startContextMs = roundDuration(nodePerformance.now() - startContextStartedAt);
  const changedFiles = Array.isArray(start.git?.files) ? start.git.files : [];
  const initialPlan = planContextGovernor(contextGovernorInputFromArgs(args, {
    repoRevision: start.repoRevision,
    changedFiles,
  }));
  const indexLimit = Math.min(initialPlan.budgets.indexLimit, parsePositiveInt(args.limit, initialPlan.budgets.indexLimit, 30));

  const repoIndexStartedAt = nodePerformance.now();
  const index = getRepoInspectionIndex(state, {
    ...args,
    projectId: project.id,
    q: query,
    path: args.path,
    limit: indexLimit,
    includeIgnored: args.includeIgnored,
    contextIntent: initialPlan.intent,
    targetFiles,
    changedFiles,
  }, undefined, { trustedRepoRevision });
  const repoIndexMs = roundDuration(nodePerformance.now() - repoIndexStartedAt);
  const indexedCandidates = Array.isArray(index.matches) ? index.matches : [];
  const indexedPaths = new Set(indexedCandidates.map((entry: any) => String(entry.path || '').replace(/\\/g, '/').toLowerCase()));
  const explicitTargetCandidates = targetFiles
    .filter((filePath) => !indexedPaths.has(filePath.replace(/\\/g, '/').toLowerCase()))
    .map((filePath) => ({ path: filePath, extension: path.extname(filePath).toLowerCase(), symbols: [], imports: [], score: 0 }));
  const contextPlan = planContextGovernor(contextGovernorInputFromArgs(args, {
    repoRevision: start.repoRevision,
    changedFiles,
    candidates: [...indexedCandidates, ...explicitTargetCandidates],
  }));
  const snippetLimit = Math.min(contextPlan.budgets.snippetLimit, parsePositiveInt(args.snippetLimit, Math.min(indexLimit, contextPlan.budgets.snippetLimit), 20));
  const explicitSnippetLines = args.snippetLines !== undefined && args.snippetLines !== null && String(args.snippetLines).trim() !== '';
  const explicitMaxSnippetBytes = args.maxSnippetBytes !== undefined && args.maxSnippetBytes !== null && String(args.maxSnippetBytes).trim() !== '';
  const explicitDisclosure = typeof args.disclosureLevel === 'string'
    || typeof args.contextDepth === 'string'
    || args.fullFile === true;
  const snippetLines = Math.min(contextPlan.budgets.snippetLines, parsePositiveInt(args.snippetLines, contextPlan.budgets.snippetLines, contextPlan.disclosureLevel === 'full-file' ? 1000 : 240));
  const baseMaxSnippetBytes = Math.min(contextPlan.budgets.perSnippetBytes, parsePositiveInt(args.maxSnippetBytes, contextPlan.budgets.perSnippetBytes, 100000));
  const aggregateContextBudget = Math.min(contextPlan.budgets.maxContextBytes, parsePositiveInt(args.maxContextBytes, contextPlan.budgets.maxContextBytes, 500000));
  const reservedMetadataBytes = Math.min(12_000, Math.floor(aggregateContextBudget * 0.25));
  const defaultSnippetBudget = Math.min(contextPlan.budgets.snippetBytes, Math.max(1, aggregateContextBudget - reservedMetadataBytes));
  const snippetByteBudget = Math.min(
    aggregateContextBudget,
    parsePositiveInt(args.maxSnippetTotalBytes, defaultSnippetBudget, 500000),
  );
  const automaticAdaptiveDisclosure = !explicitDisclosure && !explicitSnippetLines;
  const maxSnippetBytes = Math.max(1, Math.min(
    automaticAdaptiveDisclosure && !explicitMaxSnippetBytes
      ? Math.max(baseMaxSnippetBytes, ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxBytes)
      : baseMaxSnippetBytes,
    snippetByteBudget,
    aggregateContextBudget,
  ));
  const selectedEvidence = contextPlan.evidence
    .filter((entry) => entry.rank !== 'optional' || contextPlan.intent === 'architecture-analysis' || contextPlan.disclosureLevel === 'full-file')
    .slice(0, snippetLimit);

  let remainingSnippetBytes = snippetByteBudget;
  let returnedSnippetBytes = 0;
  let snippetReadCount = 0;
  const snippets: any[] = [];
  const snippetReadStartedAt = nodePerformance.now();
  if (contextPlan.disclosureLevel !== 'project-summary') {
    for (const match of selectedEvidence) {
      if (remainingSnippetBytes <= 0) break;
      const perReadBudget = Math.max(1, Math.min(maxSnippetBytes, remainingSnippetBytes));
      try {
        const metadata = readResolvedLocalFile(state, {
          ...args,
          projectId: project.id,
          filePath: match.path,
          mode: 'metadata',
        }, index.root);
        const sourceBytes = Math.max(0, Number(metadata.bytes) || 0);
        const totalLines = Math.max(1, Number(metadata.totalLines) || 1);
        const smallFile = totalLines <= ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxLines
          && sourceBytes <= ADAPTIVE_SOURCE_DISCLOSURE_POLICY.smallFileMaxBytes;
        const wholeFileFitsBudget = sourceBytes <= perReadBudget && sourceBytes <= remainingSnippetBytes;
        let adaptiveMode = explicitSnippetLines || explicitDisclosure ? 'explicit-window' : 'profile-window';
        let requestedEndLine = snippetLines;

        if (automaticAdaptiveDisclosure && match.rank === 'must' && smallFile && wholeFileFitsBudget) {
          adaptiveMode = 'whole-small-file';
          requestedEndLine = totalLines;
        } else if (automaticAdaptiveDisclosure && match.rank === 'must' && !smallFile) {
          adaptiveMode = 'bounded-large-file';
          const baseWindowEndLine = Math.min(totalLines, ADAPTIVE_SOURCE_DISCLOSURE_POLICY.largeFileWindowLines);
          const remainingTailLines = Math.max(0, totalLines - baseWindowEndLine);
          requestedEndLine = remainingTailLines > 0 && remainingTailLines <= ADAPTIVE_SOURCE_DISCLOSURE_POLICY.tinyTailMaxLines
            ? Math.min(totalLines, ADAPTIVE_SOURCE_DISCLOSURE_POLICY.maxLargeFileWindowLines)
            : baseWindowEndLine;
        } else if (automaticAdaptiveDisclosure && match.rank === 'must' && smallFile && !wholeFileFitsBudget) {
          adaptiveMode = 'budget-limited-small-file';
        }

        snippetReadCount += 1;
        const snippet = readResolvedLocalFile(state, {
          ...args,
          projectId: project.id,
          filePath: match.path,
          startLine: 1,
          endLine: requestedEndLine,
          maxBytes: perReadBudget,
        }, index.root);
        let snippetContent = String(snippet.content || '');
        let contentBytes = Buffer.byteLength(snippetContent, 'utf8');
        if (contentBytes > perReadBudget) {
          snippetContent = Buffer.from(snippetContent, 'utf8').subarray(0, perReadBudget).toString('utf8');
          while (snippetContent.length > 0 && Buffer.byteLength(snippetContent, 'utf8') > perReadBudget) {
            snippetContent = snippetContent.slice(0, -1);
          }
          snippet.content = snippetContent;
          snippet.truncated = true;
          contentBytes = Buffer.byteLength(snippetContent, 'utf8');
        }
        returnedSnippetBytes += contentBytes;
        remainingSnippetBytes = Math.max(0, remainingSnippetBytes - contentBytes);
        snippets.push({
          path: match.path,
          score: match.score,
          symbols: match.symbols,
          rank: match.rank,
          reasons: match.reasons,
          isTest: match.isTest,
          startLine: snippet.startLine,
          endLine: snippet.endLine,
          totalLines: snippet.totalLines,
          truncated: snippet.truncated,
          adaptiveDisclosure: {
            mode: adaptiveMode,
            automatic: automaticAdaptiveDisclosure,
            sourceBytes,
            totalLines,
            requestedEndLine,
            perReadBudget,
            wholeFileEligible: match.rank === 'must' && smallFile,
            wholeFileSelected: adaptiveMode === 'whole-small-file',
          },
          revision: snippet.revision,
          fileRevision: snippet.fileRevision,
          freshnessIdentity: buildRepoEvidenceIdentity({
            repoRevision: start.repoRevision,
            filePath: match.path,
            fileRevision: snippet.revision || snippet.fileRevision?.token,
          }),
          returnedBytes: contentBytes,
          content: snippet.content,
        });
      } catch (error: any) {
        snippets.push({
          path: match.path,
          score: match.score,
          rank: match.rank,
          reasons: match.reasons,
          isTest: match.isTest,
          error: error?.message || 'Could not read snippet.',
        });
      }
    }
  }

  const snippetReadMs = roundDuration(nodePerformance.now() - snippetReadStartedAt);
  const diffRequested = args.includeDiff === true || args.includeDiff === 'true';
  const diffStartedAt = nodePerformance.now();

  let diff: any = undefined;
  if (diffRequested) {
    try {
      const rawDiff = getGitDiff(state, {
        ...args,
        projectId: project.id,
        path: typeof args.diffPath === 'string' ? args.diffPath : undefined,
      });
      const maxDiffBytes = parsePositiveInt(args.maxDiffBytes, 20000, 100000);
      const content = typeof rawDiff.diff === 'string' ? rawDiff.diff : '';
      diff = {
        ...rawDiff,
        diff: content.length > maxDiffBytes ? content.slice(0, maxDiffBytes) : content,
        truncated: content.length > maxDiffBytes,
        returnedBytes: Math.min(content.length, maxDiffBytes),
        totalBytes: content.length,
      };
    } catch (error: any) {
      diff = { available: false, reason: error?.message || 'Git diff unavailable.' };
    }
  }
  const diffMs = diffRequested ? roundDuration(nodePerformance.now() - diffStartedAt) : 0;
  const responseAssemblyStartedAt = nodePerformance.now();

  const effectiveContextPlan = {
    ...contextPlan,
    budgets: {
      ...contextPlan.budgets,
      indexLimit,
      snippetLimit,
      snippetLines,
      perSnippetBytes: maxSnippetBytes,
      snippetBytes: snippetByteBudget,
      maxContextBytes: aggregateContextBudget,
    },
    selectedEvidenceCount: snippets.length,
    returnedSnippetBytes,
    remainingSnippetBytes,
    budgetExhausted: remainingSnippetBytes <= 0,
    adaptiveDisclosure: {
      automatic: automaticAdaptiveDisclosure,
      explicitSnippetLines,
      explicitMaxSnippetBytes,
      explicitDisclosure,
      policy: ADAPTIVE_SOURCE_DISCLOSURE_POLICY,
    },
  };

  const response = {
    project: start.project,
    query,
    repoRevision: start.repoRevision,
    git: start.git,
    projectAtlas: start.projectAtlas,
    hints: start.hints,
    contextPlan: effectiveContextPlan,
    index: {
      cache: index.cache,
      generatedAt: index.generatedAt,
      metadata: index.metadata,
      count: index.matches?.length || 0,
      matches: contextPlan.evidence.slice(0, indexLimit),
    },
    snippets,
    diff,
    recommendedNextTools: [
      'read_local_file',
      'get_git_diff',
      'search_local_files',
      'run_project_command',
    ],
  };
  const initialResponseAssemblyMs = roundDuration(nodePerformance.now() - responseAssemblyStartedAt);
  const initialPhases: RepoContextBundlePhaseTimings = {
    startContextMs,
    repoIndexMs,
    snippetReadMs,
    snippetReadCount,
    diffMs,
    responseAssemblyMs: initialResponseAssemblyMs,
  };
  const bundled = applyAggregateContextBudget({
    ...response,
    performance: {
      repoIndexCacheState: index.cache?.hit === true ? 'warm' as const : 'cold' as const,
      totalMs: roundDuration(nodePerformance.now() - bundleStartedAt),
      phases: initialPhases,
      dominantPhase: dominantRepoContextPhase(initialPhases),
    },
  }, aggregateContextBudget);
  const responseAssemblyMs = roundDuration(nodePerformance.now() - responseAssemblyStartedAt);
  const phases: RepoContextBundlePhaseTimings = {
    ...initialPhases,
    responseAssemblyMs,
  };
  bundled.performance = {
    repoIndexCacheState: index.cache?.hit === true ? 'warm' as const : 'cold' as const,
    totalMs: roundDuration(nodePerformance.now() - bundleStartedAt),
    phases,
    dominantPhase: dominantRepoContextPhase(phases),
  };
  stabilizeResponseBudgetBytes(bundled);
  recordRepoContextBundlePerformance(bundled.performance);
  return bundled;
}
