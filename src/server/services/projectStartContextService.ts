import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { findProjectByIdentifier } from './taskService';
import { createApiError } from './api';
import { listLocalFiles, readLocalFile } from './localFileService';
import { getGitBranch, getGitDiff, getGitStatus } from './gitService';
import { getRepoInspectionIndex } from './repoInspectionIndexService';
import { registerRepoCacheInvalidator } from './repoCacheInvalidationService';

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

export function getProjectStartContext(state: AppState, args: Record<string, any>) {
  const project = resolveProject(state, args);
  const root = project.localPath || '';
  const topLevel = root
    ? listLocalFiles(state, { projectId: project.id, path: '.', recursive: false, limit: args.limit || 80 })
    : { count: 0, files: [] };

  let git: any = { available: false };
  if (root) {
    try {
      const branch = getGitBranch(state, { projectId: project.id });
      const status = getGitStatus(state, { projectId: project.id });
      git = {
        available: true,
        branch: branch.current,
        branchCount: branch.branches.length,
        changedFiles: status.count,
        files: status.files.slice(0, 25),
      };
    } catch (error: any) {
      git = { available: false, reason: error?.message || 'Git context unavailable.' };
    }
  }

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
    },
    git,
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

export function getRepoContextBundle(state: AppState, args: Record<string, any>) {
  const project = resolveProject(state, args);
  const query = typeof args.q === 'string' ? args.q : typeof args.query === 'string' ? args.query : '';
  const indexLimit = parsePositiveInt(args.limit, 8, 20);
  const snippetLimit = parsePositiveInt(args.snippetLimit, Math.min(indexLimit, 5), 10);
  const snippetLines = parsePositiveInt(args.snippetLines, 80, 160);
  const maxSnippetBytes = parsePositiveInt(args.maxSnippetBytes, 12000, 50000);

  const start = getProjectStartContext(state, { ...args, projectId: project.id, limit: args.topLevelLimit || 40 });
  const index = getRepoInspectionIndex(state, {
    projectId: project.id,
    q: query,
    path: args.path,
    limit: indexLimit,
    includeIgnored: args.includeIgnored,
  });

  const snippets = (index.matches || []).slice(0, snippetLimit).map((match: any) => {
    try {
      const snippet = readLocalFile(state, {
        projectId: project.id,
        filePath: match.path,
        startLine: 1,
        endLine: snippetLines,
        maxBytes: maxSnippetBytes,
      });
      return {
        path: match.path,
        score: match.score,
        symbols: match.symbols,
        startLine: snippet.startLine,
        endLine: snippet.endLine,
        totalLines: snippet.totalLines,
        truncated: snippet.truncated,
        content: snippet.content,
      };
    } catch (error: any) {
      return {
        path: match.path,
        score: match.score,
        error: error?.message || 'Could not read snippet.',
      };
    }
  });

  let diff: any = undefined;
  if (args.includeDiff === true || args.includeDiff === 'true') {
    try {
      const rawDiff = getGitDiff(state, {
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

  return {
    project: start.project,
    query,
    git: start.git,
    hints: start.hints,
    index: {
      cache: index.cache,
      generatedAt: index.generatedAt,
      metadata: index.metadata,
      count: index.matches?.length || 0,
      matches: (index.matches || []).slice(0, indexLimit),
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
