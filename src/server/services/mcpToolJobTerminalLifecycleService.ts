import { createJob, requestJobCancellation, appendJobLog, type McpToolJob } from '../repositories/mcpToolJobRepository';
import { createApiError } from './api';
import { resolveBuiltinToolJobBindingArgs } from './mcpToolJobRunnerRegistry';
import { getTaskExecutionMutationBinding } from './executionSessionService.js';
import { isHarnessLifecycleAffectingTool } from './harnessExecutionGuardService.js';
import {
  recordExecutionPendingOperationReference,
  reconcileExecutionPendingOperationReference,
} from './executionCheckpointService.js';

export const AUTONOMOUS_TAIL_TOOL_NAME = 'continue_task_execution_tail';

export type DurableExecutionJobBinding = {
  operationId: string;
  executionSessionId: string;
  taskId: string;
  workspaceId: string;
  projectId: string;
  toolName: string;
};

function normalizedOptionalString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function summarizeError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

export function isTerminalJobStatus(status?: string) {
  return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
}

export function prepareDurableExecutionJobArgs(toolName: string, args: any, jobId: string) {
  if (!isHarnessLifecycleAffectingTool(toolName) && toolName !== AUTONOMOUS_TAIL_TOOL_NAME) return args;
  const sourceArgs = resolveBuiltinToolJobBindingArgs(toolName, args);
  const workspaceId = normalizedOptionalString(sourceArgs?.workspaceId);
  if (!workspaceId) return args;
  const binding = getTaskExecutionMutationBinding(sourceArgs);
  if (!binding) return args;
  const baseArgs = { ...args };
  delete baseArgs.__executionJobBinding;
  delete baseArgs.__preparedEditSourceArgs;
  if ((toolName === 'apply_prepared_edit' || toolName === 'apply_prepared_edit_plan') && sourceArgs !== args) {
    baseArgs.__preparedEditSourceArgs = sourceArgs;
  }
  baseArgs.__executionJobBinding = {
    operationId: jobId,
    executionSessionId: binding.session.id,
    taskId: binding.task.id,
    workspaceId: binding.workspaceId,
    projectId: binding.workspace.projectId,
    toolName,
  } satisfies DurableExecutionJobBinding;
  return baseArgs;
}

export function durableExecutionJobBinding(
  job: Pick<McpToolJob, 'jobId' | 'toolName' | 'args'> | null | undefined,
): DurableExecutionJobBinding | null {
  const raw = job?.args?.__executionJobBinding;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding: DurableExecutionJobBinding = {
    operationId: String(raw.operationId || '').trim(),
    executionSessionId: String(raw.executionSessionId || '').trim(),
    taskId: String(raw.taskId || '').trim(),
    workspaceId: String(raw.workspaceId || '').trim(),
    projectId: String(raw.projectId || '').trim(),
    toolName: String(raw.toolName || '').trim(),
  };
  if (
    !binding.operationId
    || !binding.executionSessionId
    || !binding.taskId
    || !binding.workspaceId
    || !binding.projectId
    || binding.operationId !== job?.jobId
    || binding.toolName !== job?.toolName
  ) {
    throw createApiError(409, 'MCP_JOB_EXECUTION_BINDING_INVALID', `Durable MCP job '${job?.jobId || 'unknown'}' has an invalid immutable execution binding.`);
  }
  return binding;
}

export function recordDurableExecutionPending(
  job: Pick<McpToolJob, 'jobId' | 'toolName' | 'args'>,
  status: 'accepted' | 'running',
) {
  const binding = durableExecutionJobBinding(job);
  if (!binding) return null;
  const authorityArgs = resolveBuiltinToolJobBindingArgs(job.toolName, job.args);
  const current = getTaskExecutionMutationBinding(authorityArgs);
  if (!current || current.session.id !== binding.executionSessionId) {
    throw createApiError(409, 'MCP_JOB_EXECUTION_FENCED', `Durable MCP job '${job.jobId}' is no longer bound to the active admitted execution.`);
  }
  return recordExecutionPendingOperationReference(binding.executionSessionId, {
    operationId: binding.operationId,
    evidenceId: `mcp-job:${job.jobId}`,
    kind: `mcp-tool-job:${job.toolName}`,
    status,
  });
}

export function reconcileTerminalDurableExecution(job: McpToolJob | null | undefined) {
  if (!job || !isTerminalJobStatus(job.status)) return false;
  const binding = durableExecutionJobBinding(job);
  if (!binding) return false;
  reconcileExecutionPendingOperationReference(binding.executionSessionId, binding.operationId);
  return true;
}

export function safelyReconcileTerminalDurableExecution(job: McpToolJob | null | undefined) {
  try {
    return reconcileTerminalDurableExecution(job);
  } catch (error) {
    if (job?.jobId) appendJobLog(job.jobId, 'stderr', `\n[Execution Pending Reconciliation] ${summarizeError(error)}\n`);
    return false;
  }
}

export function createAcceptedDurableToolJob(
  jobId: string,
  toolName: string,
  args: any,
  resourceKey: string,
  options: { eagerArtifacts?: boolean } = {},
) {
  const durableArgs = prepareDurableExecutionJobArgs(toolName, args, jobId);
  const job = createJob(jobId, toolName, durableArgs, resourceKey, options);
  try {
    recordDurableExecutionPending(job, 'accepted');
    return job;
  } catch (error) {
    const cancelled = requestJobCancellation(jobId, 'Durable execution binding could not be recorded at admission.');
    if (cancelled) safelyReconcileTerminalDurableExecution(cancelled);
    throw createApiError(409, 'MCP_JOB_EXECUTION_BINDING_REJECTED', `Durable MCP job '${jobId}' could not bind to its admitted execution.`, {
      details: { cause: summarizeError(error) },
    });
  }
}
