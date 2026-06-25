import { withSyncLock } from './lockAndIdempotencyService';
import { triggerTaskAgent, completeAgentRunForTask, applyAgentCompletionCallback, maybeTriggerTaskAgent } from '../routes/taskRouteSupport';
import { cancelActiveRunsForTask } from '../repositories/agentRunRepository';
import type { ApiRouteDeps } from '../types';
import type { AgentCompletionPayload } from '../../types';

export class AgentOrchestrationWorker {
  static trigger(task: any, deps: ApiRouteDeps, routeLabel: string, retryOfRunId?: string | null) {
    return withSyncLock(`agent-orchestration-${task.id}`, () => {
      return triggerTaskAgent(task, deps, routeLabel, retryOfRunId);
    });
  }

  static maybeTrigger(task: any, previousTaskOrStatus: any, deps: ApiRouteDeps, routeLabel: string) {
    return withSyncLock(`agent-orchestration-${task.id}`, () => {
      return maybeTriggerTaskAgent(task, previousTaskOrStatus, deps, routeLabel);
    });
  }

  static complete(task: any, run: any, deps: ApiRouteDeps, options: { success: boolean; exitCode?: number | null; errorMessage?: string }) {
    return withSyncLock(`agent-orchestration-${task.id}`, () => {
      return completeAgentRunForTask(task, run, deps, options);
    });
  }

  static applyCompletionCallback(task: any, run: any, deps: ApiRouteDeps, payload: AgentCompletionPayload) {
    return withSyncLock(`agent-orchestration-${task.id}`, () => {
      return applyAgentCompletionCallback(task, run, deps, payload);
    });
  }

  static cancelRuns(taskId: string, reason: string) {
    return withSyncLock(`agent-orchestration-${taskId}`, () => {
      return cancelActiveRunsForTask(taskId, reason);
    });
  }
}
