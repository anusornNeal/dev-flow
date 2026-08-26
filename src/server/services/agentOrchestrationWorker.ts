import { triggerTaskAgent, completeAgentRunForTask, applyAgentCompletionCallback, maybeTriggerTaskAgent, withAgentOrchestrationLock } from '../routes/taskRouteSupport';
import { cancelActiveRunsForTask } from '../repositories/agentRunRepository';
import type { ApiRouteDeps } from '../types';
import type { AgentCompletionPayload } from '../../types';

/** Compatibility facade for legacy launched-agent routes. Lock ownership is centralized in taskRouteSupport so this facade no longer forms an orchestration dependency cycle. */
export class AgentOrchestrationWorker {
  static trigger(task: any, deps: ApiRouteDeps, routeLabel: string, retryOfRunId?: string | null) {
    return withAgentOrchestrationLock(task.id, () => {
      return triggerTaskAgent(task, deps, routeLabel, retryOfRunId);
    });
  }

  static maybeTrigger(task: any, previousTaskOrStatus: any, deps: ApiRouteDeps, routeLabel: string) {
    return withAgentOrchestrationLock(task.id, () => {
      return maybeTriggerTaskAgent(task, previousTaskOrStatus, deps, routeLabel);
    });
  }

  static complete(task: any, run: any, deps: ApiRouteDeps, options: { success: boolean; exitCode?: number | null; errorMessage?: string }) {
    return withAgentOrchestrationLock(task.id, () => {
      return completeAgentRunForTask(task, run, deps, options);
    });
  }

  static applyCompletionCallback(task: any, run: any, deps: ApiRouteDeps, payload: AgentCompletionPayload) {
    return withAgentOrchestrationLock(task.id, () => {
      return applyAgentCompletionCallback(task, run, deps, payload);
    });
  }

  static cancelRuns(taskId: string, reason: string) {
    return withAgentOrchestrationLock(taskId, () => {
      return cancelActiveRunsForTask(taskId, reason);
    });
  }
}
