import type { AppState } from '../types';
import { getProjects } from '../repositories/projectRepository';
import { applyAndVerifyAsync } from './applyAndVerifyService';
import { editFilesBatch } from './fileEditBatchService';
import { commitGitChanges, ensureGitBranch, pushGitBranch } from './gitService';
import { commitTaskOwnedChanges } from './taskCommitPlanService.js';
import { applyLocalPatchAsync } from './localPatchService';
import { searchLocalFilesAsync } from './localFileService';
import { deleteLocalPath, moveLocalPath } from './localPathMutationService';
import { applyPreparedEditPlan, getPreparedEditRecoveryArgs, prepareEditPlan } from './preparedEditService';
import { applyProjectAtlasAgentUpdate } from './projectAtlasService';
import { runProjectCommandAsync } from './projectCommandService';
import { prepareCompactEdit } from './stenoEditProtocolService';
import type { ResourceAccessMode } from './mcpToolJobScheduler';
import { executeRecoveryAwareTool } from './devFlowRecoveryRuntime.js';
import {
  getActiveTaskExecutionSessionForWorkspace,
  recordExecutionOwnedChanges,
  recordExecutionVerificationEvidence,
} from './executionSessionService.js';
import { resolveSessionWorkspace } from './sessionWorkspaceService.js';

type Logger = { stdout: (data: string) => void; stderr: (data: string) => void };
type VerificationPermitDemand = { verificationClass?: 'fast' | 'heavy'; sharedResources?: string[] };
type VerificationExecutionLease = {
  runWithPermit: <T>(request: VerificationPermitDemand, run: () => Promise<T>) => Promise<T>;
  dispose: () => void;
};

export interface BuiltinToolJobInput {
  toolName: string;
  state: AppState;
  args: any;
}

export interface BuiltinToolJobContext {
  logger: Logger;
  setCancelFn: (fn: () => void) => void;
  transitionAccess: (
    accessMode: ResourceAccessMode,
    request?: VerificationPermitDemand,
  ) => void | VerificationExecutionLease | Promise<void | VerificationExecutionLease>;
}

export type BuiltinToolJobRecoveryPolicy = 'retryable' | 'interrupted';

const BUILTIN_TOOL_RUNNER_NAMES = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'commit_task_owned_changes',
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

const RETRYABLE_AFTER_RESTART = new Set<string>([
  'search_local_files',
]);

export function getBuiltinToolRunnerNames() {
  return [...BUILTIN_TOOL_RUNNER_NAMES];
}

export function getBuiltinToolJobRecoveryPolicy(toolName: string): BuiltinToolJobRecoveryPolicy {
  return RETRYABLE_AFTER_RESTART.has(toolName) ? 'retryable' : 'interrupted';
}

function taskExecutionBinding(args: any) {
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!workspaceId) return null;
  const session = getActiveTaskExecutionSessionForWorkspace(workspaceId);
  if (!session?.taskId) return null;
  const workspace = resolveSessionWorkspace(workspaceId);
  if (!workspace || workspace.projectId !== session.projectId) return null;
  return { session, workspace };
}

function recordTaskOwnedMutation(args: any, result: any, source: string) {
  if (!result?.ok || result?.dryRun === true || result?.changed !== true) return;
  const binding = taskExecutionBinding(args);
  if (!binding) return;
  const changedPaths = Array.isArray(result.files)
    ? result.files
      .filter((entry: any) => entry?.ok && entry?.changed && typeof entry?.filePath === 'string')
      .map((entry: any) => entry.filePath)
    : [];
  if (changedPaths.length === 0) return;
  recordExecutionOwnedChanges(binding.session.id, changedPaths, {
    repoRoot: binding.workspace.root,
    source,
  });
}

function recordTaskVerification(args: any, result: any) {
  if (!result?.ok || result?.status !== 'succeeded') return;
  const binding = taskExecutionBinding(args);
  if (!binding) return;
  recordExecutionVerificationEvidence(binding.session.id, [{
    name: String(args?.command || args?.preset || 'run_project_command'),
    status: 'passed',
  }], { repoRoot: binding.workspace.root });
}

export async function runBuiltinToolJob(input: BuiltinToolJobInput, context: BuiltinToolJobContext) {
  const { toolName, state, args } = input;
  const { logger, setCancelFn, transitionAccess } = context;

  if (toolName === 'run_project_command') {
    const result = await runProjectCommandAsync(state, args, logger, setCancelFn);
    recordTaskVerification(args, result);
    return result;
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
  if (toolName === 'commit_task_owned_changes') return commitTaskOwnedChanges(state, args);
  if (toolName === 'edit_local_files_batch') {
    const result = editFilesBatch(state, args);
    recordTaskOwnedMutation(args, result, toolName);
    return result;
  }
  if (toolName === 'prepare_edit_plan') return prepareEditPlan(state, args);
  if (toolName === 'apply_prepared_edit_plan') {
    const sourceArgs = getPreparedEditRecoveryArgs(String(args?.editPlanId || '')) || args;
    const result = await executeRecoveryAwareTool(state, toolName, args, (payload) => applyPreparedEditPlan(payload));
    recordTaskOwnedMutation(sourceArgs, result, toolName);
    return result;
  }
  if (toolName === 'prepare_compact_edit') return prepareCompactEdit(state, args);
  if (toolName === 'apply_prepared_edit') {
    const sourceArgs = getPreparedEditRecoveryArgs(String(args?.editPlanId || '')) || args;
    const payload = { editPlanId: args?.editPlanId };
    const result = await executeRecoveryAwareTool(state, toolName, payload, (nextPayload) => applyPreparedEditPlan(nextPayload));
    recordTaskOwnedMutation(sourceArgs, result, toolName);
    return result;
  }
  if (toolName === 'apply_and_verify') {
    const result = await applyAndVerifyAsync(state, args, logger, setCancelFn, transitionAccess);
    recordTaskOwnedMutation(args, result?.edit, toolName);
    if (result?.ok === true) {
      const binding = taskExecutionBinding(args);
      if (binding) {
        recordExecutionVerificationEvidence(binding.session.id, Array.isArray(result.verification) ? result.verification : [], {
          repoRoot: binding.workspace.root,
        });
      }
    }
    return result;
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
