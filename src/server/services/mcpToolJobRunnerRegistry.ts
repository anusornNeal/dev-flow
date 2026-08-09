import type { AppState } from '../types';
import { getProjects } from '../repositories/projectRepository';
import { applyAndVerifyAsync } from './applyAndVerifyService';
import { editFilesBatch } from './fileEditBatchService';
import { commitGitChanges, ensureGitBranch, pushGitBranch } from './gitService';
import { applyLocalPatchAsync } from './localPatchService';
import { searchLocalFilesAsync } from './localFileService';
import { deleteLocalPath, moveLocalPath } from './localPathMutationService';
import { applyPreparedEditPlan, prepareEditPlan } from './preparedEditService';
import { applyProjectAtlasAgentUpdate } from './projectAtlasService';
import { runProjectCommandAsync } from './projectCommandService';
import { prepareCompactEdit } from './stenoEditProtocolService';
import type { ResourceAccessMode } from './mcpToolJobScheduler';
import { executeRecoveryAwareTool } from './devFlowRecoveryRuntime.js';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };

export interface BuiltinToolJobInput {
  toolName: string;
  state: AppState;
  args: any;
}

export interface BuiltinToolJobContext {
  logger: Logger;
  setCancelFn: (fn: () => void) => void;
  transitionAccess: (accessMode: ResourceAccessMode) => void;
}

const BUILTIN_TOOL_RUNNER_NAMES = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'edit_local_files_batch',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'prepare_compact_edit',
  'apply_prepared_edit',
  'apply_and_verify',
  'delete_local_path',
  'move_local_path',
  'apply_project_atlas_agent_update',
] as const;

export function getBuiltinToolRunnerNames() {
  return [...BUILTIN_TOOL_RUNNER_NAMES];
}

export async function runBuiltinToolJob(input: BuiltinToolJobInput, context: BuiltinToolJobContext) {
  const { toolName, state, args } = input;
  const { logger, setCancelFn, transitionAccess } = context;

  if (toolName === 'run_project_command') {
    return await runProjectCommandAsync(state, args, logger, setCancelFn);
  }
  if (toolName === 'apply_patch') {
    return await applyLocalPatchAsync(state, args, logger, setCancelFn);
  }
  if (toolName === 'search_local_files') {
    return await executeRecoveryAwareTool(
      state,
      toolName,
      args,
      (payload) => searchLocalFilesAsync(state, payload, logger, setCancelFn),
    );
  }
  if (toolName === 'ensure_git_branch') return ensureGitBranch(state, args);
  if (toolName === 'push_git_branch') return pushGitBranch(state, args);
  if (toolName === 'commit_git_changes') return commitGitChanges(state, args);
  if (toolName === 'edit_local_files_batch') return editFilesBatch(state, args);
  if (toolName === 'prepare_edit_plan') return prepareEditPlan(state, args);
  if (toolName === 'apply_prepared_edit_plan') {
    return await executeRecoveryAwareTool(state, toolName, args, (payload) => applyPreparedEditPlan(payload));
  }
  if (toolName === 'prepare_compact_edit') return prepareCompactEdit(state, args);
  if (toolName === 'apply_prepared_edit') {
    const payload = { editPlanId: args?.editPlanId };
    return await executeRecoveryAwareTool(state, toolName, payload, (nextPayload) => applyPreparedEditPlan(nextPayload));
  }
  if (toolName === 'apply_and_verify') {
    return await applyAndVerifyAsync(state, args, logger, setCancelFn, transitionAccess);
  }
  if (toolName === 'delete_local_path') return deleteLocalPath(state, args);
  if (toolName === 'move_local_path') return moveLocalPath(state, args);
  if (toolName === 'apply_project_atlas_agent_update') {
    const project = findProjectForAtlasUpdate(args);
    if (!project) throw new Error('Project not found for Project Atlas agent update.');
    logger.stdout(`[Project Atlas] Saving ChatGPT-authored Atlas for ${project.name || project.id}\n`);
    return applyProjectAtlasAgentUpdate(project, args);
  }
  throw new Error(`No async runner implemented for tool: ${toolName}`);
}

function findProjectForAtlasUpdate(args: any) {
  const projects = getProjects();
  if (args?.projectId) {
    const byId = projects.find((project) => project.id === args.projectId);
    if (byId) return byId;
  }
  if (args?.projectName) {
    const normalizedName = String(args.projectName).trim().toLowerCase();
    const byName = projects.find((project) => project.name.trim().toLowerCase() === normalizedName);
    if (byName) return byName;
  }
  if (args?.localPath) {
    const normalizedPath = String(args.localPath).trim().toLowerCase();
    const byPath = projects.find((project) => String(project.localPath || '').trim().toLowerCase() === normalizedPath);
    if (byPath) return byPath;
  }
  return null;
}
