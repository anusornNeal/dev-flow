import type { AppState } from '../types.js';
import { getProject } from '../repositories/projectRepository.js';
import { getTaskByIdentifier, getTasks } from '../repositories/taskRepository.js';
import { getJob, listRecentJobs, type McpToolJob } from '../repositories/mcpToolJobRepository.js';
import { DEVFLOW_CONTRACT_VERSION, getCapabilityCatalog } from '../contracts/devflowContract.js';
import { findProjectByIdentifier } from './taskService.js';
import { classifyRuntimeIdentity, getRuntimeIdentity, type RuntimeClientState } from './runtimeIdentityService.js';
import { inspectWorkspaceRecovery, type WorkspaceRecoveryInspection } from './workspaceRecoveryService.js';

export type WorkflowRecoveryContinuationAction =
  | 'query-job'
  | 'continue-workspace'
  | 'finish-integration'
  | 'no-action'
  | 'blocked';

type RecoveryArgs = {
  projectId?: string;
  projectName?: string;
  repo?: string;
  repoUrl?: string;
  localPath?: string;
  taskId?: string;
  workspaceId?: string;
  jobId?: string;
  previousContractVersion?: string;
  previousRuntimeInstanceId?: string;
  previousToolSurfaceIdentity?: string;
  clientToolsVisible?: boolean | string;
};

function clean(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function clientStateFromArgs(args: RecoveryArgs): RuntimeClientState | undefined {
  const toolsVisible = args.clientToolsVisible === true || args.clientToolsVisible === 'true'
    ? true
    : args.clientToolsVisible === false || args.clientToolsVisible === 'false'
      ? false
      : undefined;
  const state: RuntimeClientState = {
    contractVersion: clean(args.previousContractVersion) || undefined,
    runtimeInstanceId: clean(args.previousRuntimeInstanceId) || undefined,
    toolSurfaceIdentity: clean(args.previousToolSurfaceIdentity) || undefined,
    toolsVisible,
  };
  return state.contractVersion || state.runtimeInstanceId || state.toolSurfaceIdentity || state.toolsVisible !== undefined ? state : undefined;
}

function runtimeDiagnosis(args: RecoveryArgs) {
  const capabilityCatalog = getCapabilityCatalog();
  const current = {
    ...getRuntimeIdentity(),
    contractVersion: DEVFLOW_CONTRACT_VERSION,
    toolSurfaceIdentity: capabilityCatalog.mcpProfile.toolSurfaceIdentity,
  };
  return classifyRuntimeIdentity(current, clientStateFromArgs(args));
}

function compactTask(task: any) {
  return task ? {
    id: task.id,
    displayId: task.displayId,
    title: task.title,
    status: task.status,
    projectId: task.projectId,
  } : undefined;
}

function compactProject(project: any) {
  return project ? { id: project.id, name: project.name } : undefined;
}

function compactWorkspace(inspection: WorkspaceRecoveryInspection) {
  return {
    workspaceId: inspection.workspaceId,
    ...(inspection.state ? { state: inspection.state } : {}),
    ...(inspection.branch ? { branch: inspection.branch } : {}),
    ...(inspection.baseBranch ? { baseBranch: inspection.baseBranch } : {}),
    disposition: inspection.disposition,
    dirtyFiles: inspection.dirtyFiles.slice(0, 50),
    sourceCommits: inspection.sourceCommits.slice(-20),
    uniqueCommits: inspection.uniqueCommits.slice(-20),
    ...(inspection.baseHead ? { baseHead: inspection.baseHead } : {}),
    ...(inspection.sourceHead ? { sourceHead: inspection.sourceHead } : {}),
    ...(inspection.reason ? { reason: inspection.reason } : {}),
  };
}

function compactJob(job: McpToolJob) {
  return {
    jobId: job.jobId,
    toolName: job.toolName,
    status: job.status,
    recoveryClassification: job.recoveryClassification || (['queued', 'running'].includes(job.status) ? 'resumable' : 'terminal'),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.completedAt ? { completedAt: job.completedAt } : {}),
    ...(job.supersededAt ? { supersededAt: job.supersededAt } : {}),
  };
}

function jobMatches(job: McpToolJob, task: any, workspaceId: string, projectId: string) {
  if (workspaceId && clean(job.args?.workspaceId) === workspaceId) return true;
  if (task) {
    const taskId = clean(job.args?.taskId);
    if (taskId && (taskId === task.id || taskId === task.displayId)) return true;
  }
  return Boolean(projectId && clean(job.args?.projectId) === projectId && !workspaceId && !task);
}

function blocked(reason: string, extra: Record<string, any> = {}) {
  return {
    status: 'blocked' as const,
    ...extra,
    continuation: { action: 'blocked' as const, reason },
  };
}

export function getWorkflowRecoveryHandoff(state: AppState, args: RecoveryArgs = {}) {
  const diagnosis = runtimeDiagnosis(args);
  const explicitTaskId = clean(args.taskId);
  const explicitWorkspaceId = clean(args.workspaceId);
  const explicitJobId = clean(args.jobId);
  const exactJob = explicitJobId ? getJob(explicitJobId) : null;
  if (explicitJobId && !exactJob) {
    return blocked(`Durable job '${explicitJobId}' was not found; recovery will not guess a replacement workflow boundary.`, {
      ...(diagnosis ? { diagnosis } : {}),
      candidates: { tasks: [], workspaces: [] },
    });
  }

  let task = explicitTaskId ? getTaskByIdentifier(explicitTaskId, 'summary') : undefined;
  const hasExplicitProjectSelector = [args.projectId, args.projectName, args.repo, args.repoUrl, args.localPath]
    .some((value) => clean(value));
  const requestedProject = hasExplicitProjectSelector ? findProjectByIdentifier(state, args) : null;
  const taskWorkspaceId = clean(task?.claim?.workspaceId);
  const jobWorkspaceId = clean(exactJob?.args?.workspaceId);
  const jobTaskId = clean(exactJob?.args?.taskId);
  const jobProjectId = clean(exactJob?.args?.projectId);
  const workspaceSelectors = [explicitWorkspaceId, taskWorkspaceId, jobWorkspaceId].filter(Boolean);
  const taskMatchesJob = !task || !jobTaskId || jobTaskId === task.id || jobTaskId === task.displayId;
  const projectSelectorsAgree = !requestedProject
    || ((!task?.projectId || task.projectId === requestedProject.id) && (!jobProjectId || jobProjectId === requestedProject.id));
  if (!taskMatchesJob || new Set(workspaceSelectors).size > 1 || !projectSelectorsAgree) {
    return blocked('Supplied recovery identifiers conflict and refer to different durable workflow state; recovery will not compose or replay across boundaries.', {
      ...(diagnosis ? { diagnosis } : {}),
      ...(requestedProject ? { project: compactProject(requestedProject) } : {}),
      candidates: {
        tasks: [task?.id, jobTaskId].filter(Boolean),
        workspaces: [...new Set(workspaceSelectors)],
      },
    });
  }

  let workspaceId = explicitWorkspaceId || jobWorkspaceId || taskWorkspaceId;
  let project = requestedProject || (task?.projectId ? getProject(task.projectId) : undefined) || (jobProjectId ? getProject(jobProjectId) : undefined);

  if (!task && workspaceId) {
    const matches = getTasks().filter((candidate) => clean(candidate?.claim?.workspaceId) === workspaceId);
    if (matches.length === 1) task = getTaskByIdentifier(matches[0].id, 'summary');
    if (matches.length > 1) {
      return blocked('Recovery is ambiguous because multiple tasks reference the same managed workspace.', {
        ...(diagnosis ? { diagnosis } : {}),
        ...(project ? { project: compactProject(project) } : {}),
        candidates: { tasks: matches.map((candidate) => candidate.id), workspaces: [workspaceId] },
      });
    }
  }

  if (!task && project) {
    const activeClaims = getTasks().filter((candidate) =>
      candidate.projectId === project.id
      && candidate.status === 'in-progress'
      && clean(candidate?.claim?.workspaceId),
    );
    if (activeClaims.length > 1) {
      return blocked('Recovery is ambiguous because multiple active claimed workspaces exist for this project.', {
        ...(diagnosis ? { diagnosis } : {}),
        project: compactProject(project),
        candidates: {
          tasks: activeClaims.map((candidate) => candidate.id),
          workspaces: activeClaims.map((candidate) => clean(candidate.claim.workspaceId)),
        },
      });
    }
    if (activeClaims.length === 1) {
      task = getTaskByIdentifier(activeClaims[0].id, 'summary');
      workspaceId = workspaceId || clean(task?.claim?.workspaceId);
    }
  }

  if (!project && task?.projectId) project = getProject(task.projectId);
  if (!workspaceId) workspaceId = clean(task?.claim?.workspaceId);

  let inspection: WorkspaceRecoveryInspection | undefined;
  if (workspaceId) inspection = inspectWorkspaceRecovery(workspaceId);
  if (!project && inspection?.projectId) project = getProject(inspection.projectId);

  if (!task && !inspection && !exactJob && !project) {
    return blocked('Recovery cannot prove a relevant project, task, workspace, or durable job from the supplied identifiers.', {
      ...(diagnosis ? { diagnosis } : {}),
      candidates: { tasks: [], workspaces: [] },
    });
  }

  const projectId = clean(project?.id) || clean(task?.projectId) || clean(inspection?.projectId) || clean(exactJob?.args?.projectId);
  const relevantJobs = exactJob
    ? [exactJob]
    : listRecentJobs(200).filter((job) => jobMatches(job, task, workspaceId, projectId)).slice(0, 20);
  const jobs = relevantJobs.map(compactJob);
  const common = {
    status: 'recoverable' as const,
    generatedAt: new Date().toISOString(),
    ...(diagnosis ? { diagnosis } : {}),
    ...(project ? { project: compactProject(project) } : {}),
    ...(task ? { task: compactTask(task) } : {}),
    ...(inspection ? { workspace: compactWorkspace(inspection) } : {}),
    jobs,
  };

  const reusableJob = relevantJobs.find((job) => job.status === 'queued' || job.status === 'running' || job.status === 'succeeded');
  if (reusableJob) {
    return {
      ...common,
      continuation: {
        action: 'query-job' as const,
        jobId: reusableJob.jobId,
        reason: reusableJob.status === 'succeeded'
          ? 'Durable work already succeeded; query the stored result instead of starting duplicate execution.'
          : 'Durable work is already accepted; query or wait for this job instead of starting duplicate execution.',
      },
    };
  }

  const interrupted = relevantJobs.find((job) => job.recoveryClassification === 'interrupted');
  if (interrupted) {
    return {
      ...common,
      status: 'blocked' as const,
      continuation: {
        action: 'blocked' as const,
        jobId: interrupted.jobId,
        ...(workspaceId ? { workspaceId } : {}),
        reason: 'An unsafe mutation was interrupted. Manual continuation from durable workspace state is required; DevFlow will not replay it automatically.',
      },
    };
  }

  if (inspection?.disposition === 'stale-registry') {
    return {
      ...common,
      status: 'blocked' as const,
      continuation: {
        action: 'blocked' as const,
        workspaceId,
        reason: `Managed workspace state is not authoritative (${inspection.reason || 'stale registry'}); stop instead of guessing or creating duplicate work.`,
      },
    };
  }

  if (inspection?.disposition === 'needs-recovery') {
    return {
      ...common,
      continuation: {
        action: 'continue-workspace' as const,
        workspaceId,
        reason: 'Resume the original managed workspace because it contains dirty or uncommitted work.',
      },
    };
  }

  if (inspection && (inspection.state === 'integration-required' || inspection.disposition === 'committed-not-integrated')) {
    return {
      ...common,
      continuation: {
        action: 'finish-integration' as const,
        workspaceId,
        reason: 'The managed workspace contains committed work that is not integrated into its local base.',
      },
    };
  }

  if (inspection && task?.status === 'in-progress') {
    return {
      ...common,
      continuation: {
        action: 'continue-workspace' as const,
        workspaceId,
        reason: 'The task is still in progress; continue from the existing managed workspace rather than creating a parallel workspace.',
      },
    };
  }

  return {
    ...common,
    status: 'current' as const,
    continuation: {
      action: 'no-action' as const,
      reason: 'No durable job or managed workspace state requires recovery.',
    },
  };
}
