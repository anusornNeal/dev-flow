import fs from 'fs';
import path from 'path';
import type { AppState } from '../types';
import { findProjectByIdentifier } from './taskService';
import { createApiError } from './api';
import { listLocalFiles } from './localFileService';
import { getGitBranch, getGitStatus } from './gitService';

const HINT_FILES = ['AGENTS.md', 'README.md', 'package.json', 'tsconfig.json', 'vite.config.ts', 'gradlew.bat', 'build.gradle', 'settings.gradle'];

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
