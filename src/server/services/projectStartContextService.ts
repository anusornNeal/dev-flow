import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { findProjectByIdentifier } from './taskService';
import { createApiError } from './api';
import { listLocalFiles, readLocalFile, resolveProjectRoot, searchLocalFiles } from './localFileService';
import { getGitDiff } from './gitService';
import { getRepoInspectionIndex } from './repoInspectionIndexService';
import { registerRepoCacheInvalidator } from './repoCacheInvalidationService';
import { buildRepoEvidenceIdentity, getRepoRevisionForRoot } from './repoRevisionService';
import { planContextBudget } from './contextBudgetPlannerService';
import { ensureRepoChangeWatcher } from './workspaceChangeWatcherService';
import { maybeRefreshAtlasOnProjectOpen } from './projectAtlasService.js';

const HINT_FILES = ['AGENTS.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'gradlew.bat', 'build.gradle', 'settings.gradle'];

export function clearRepoContextBundleCache(_root?: string) {
  // getRepoContextBundle is intentionally assembled from fresh git/snippets plus the repo index cache.
  // Register a no-op invalidator so workflow health can report bundle cache readiness consistently.
  return 0;
}

registerRepoCacheInvalidator('repo-context-bundle', clearRepoContextBundleCache);

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

export function getProjectStartContext(state: AppState, args: Record<string, any>) {
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

  const presentHints = root
    ? HINT_FILES.filter((fileName) => fs.existsSync(path.join(root, fileName)))
    : [];

  return {
    project: {
      id: project.id,
      name: project.name,
      repoUrl: project.repoUrl,
      localPath: project.localPath,
      taskIdPrefix: project.taskIdPrefix,
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
      recommendedReads: presentHints.filter((fileName) => ['AGENTS.md', 'README.md', 'package.json'].includes(fileName)),
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

export function getRepoContextBundle(state: AppState, args: Record<string, any>) {
  const project = resolveProject(state, args);
  const query = typeof args.q === 'string' ? args.q : typeof args.query === 'string' ? args.query : '';
  const targetFiles = Array.isArray(args.targetFiles)
    ? args.targetFiles.map(String).map((value) => value.trim()).filter(Boolean)
    : typeof args.targetFiles === 'string'
      ? args.targetFiles.split(',').map((value: string) => value.trim()).filter(Boolean)
      : [];
  const requestedIntent = String(args.contextIntent || args.intent || '').trim().toLowerCase();
  const deepArchitectureRequested = (args.deep === true || args.deep === 'true')
    && (requestedIntent === 'architecture' || requestedIntent === 'architecture-analysis');
  const requestedDisclosureLevel = typeof args.disclosureLevel === 'string'
    ? args.disclosureLevel
    : typeof args.contextDepth === 'string'
      ? args.contextDepth
      : deepArchitectureRequested || args.fullFile === true
        ? 'full-file'
        : undefined;

  const start = getProjectStartContext(state, { ...args, projectId: project.id, limit: args.topLevelLimit || 40 });
  const changedFiles = Array.isArray(start.git?.files) ? start.git.files : [];
  const initialPlan = planContextBudget({
    query,
    intent: args.contextIntent || args.intent,
    complexity: args.complexity,
    targetFiles,
    changedFiles,
    requestedDisclosureLevel,
  });
  const indexLimit = parsePositiveInt(args.limit, initialPlan.budgets.indexLimit, 30);

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
  });
  const indexedCandidates = Array.isArray(index.matches) ? index.matches : [];
  const indexedPaths = new Set(indexedCandidates.map((entry: any) => String(entry.path || '').replace(/\\/g, '/').toLowerCase()));
  const explicitTargetCandidates = targetFiles
    .filter((filePath) => !indexedPaths.has(filePath.replace(/\\/g, '/').toLowerCase()))
    .map((filePath) => ({ path: filePath, extension: path.extname(filePath).toLowerCase(), symbols: [], imports: [], score: 0 }));
  const contextPlan = planContextBudget({
    query,
    intent: initialPlan.intent,
    complexity: args.complexity,
    candidates: [...indexedCandidates, ...explicitTargetCandidates],
    targetFiles,
    changedFiles,
    requestedDisclosureLevel,
  });
  const snippetLimit = parsePositiveInt(args.snippetLimit, Math.min(indexLimit, contextPlan.budgets.snippetLimit), 20);
  const snippetLines = parsePositiveInt(args.snippetLines, contextPlan.budgets.snippetLines, contextPlan.disclosureLevel === 'full-file' ? 1000 : 240);
  const maxSnippetBytes = parsePositiveInt(args.maxSnippetBytes, contextPlan.budgets.perSnippetBytes, 100000);
  const snippetByteBudget = parsePositiveInt(args.maxContextBytes ?? args.maxSnippetTotalBytes, contextPlan.budgets.snippetBytes, 500000);
  const selectedEvidence = contextPlan.evidence
    .filter((entry) => entry.rank !== 'optional' || contextPlan.intent === 'architecture-analysis' || contextPlan.disclosureLevel === 'full-file')
    .slice(0, snippetLimit);

  let remainingSnippetBytes = snippetByteBudget;
  let returnedSnippetBytes = 0;
  const snippets: any[] = [];
  if (contextPlan.disclosureLevel !== 'project-summary') {
    for (const match of selectedEvidence) {
      if (remainingSnippetBytes <= 0) break;
      const perReadBudget = Math.max(1, Math.min(maxSnippetBytes, remainingSnippetBytes));
      try {
        const snippet = readLocalFile(state, {
          ...args,
          projectId: project.id,
          filePath: match.path,
          startLine: 1,
          endLine: snippetLines,
          maxBytes: perReadBudget,
        });
        const contentBytes = Buffer.byteLength(String(snippet.content || ''), 'utf8');
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

  let diff: any = undefined;
  if (args.includeDiff === true || args.includeDiff === 'true') {
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

  const effectiveContextPlan = {
    ...contextPlan,
    budgets: {
      ...contextPlan.budgets,
      indexLimit,
      snippetLimit,
      snippetLines,
      perSnippetBytes: maxSnippetBytes,
      snippetBytes: snippetByteBudget,
      maxContextBytes: parsePositiveInt(args.maxContextBytes, contextPlan.budgets.maxContextBytes, 500000),
    },
    selectedEvidenceCount: snippets.length,
    returnedSnippetBytes,
    remainingSnippetBytes,
    budgetExhausted: remainingSnippetBytes <= 0,
  };

  return {
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
}
