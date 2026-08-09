import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveTask } from '../repositories/taskRepository.js';
import { sendApiError } from '../services/api';
import { findTaskByIdentifier } from '../services/taskService';
import { buildTaskGitWarnings, evaluateReviewSubmission, syncTaskWithGit } from '../services/taskGitWorkflowService';
import { appendTaskLog, canOverrideTaskLock, syncTaskAgentStateForStatus, toMutationResponse, toTaskResponse } from './taskRouteSupport';

export function registerTaskReviewRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.post('/api/tasks/:id/sync-git', (req, res) => {
    try {
      const task = findTaskByIdentifier(deps.state, req.params.id);
      if (!task) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found.' } });
      if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, req.query, req.headers['x-agent-request'])) {
        return res.status(403).json({ error: { code: 'TASK_LOCKED', message: 'Task is locked by an agent. Set isAgentRequest or emergency when authorized.' } });
      }
      const result = syncTaskWithGit(deps.state, task, req.body || {});
      appendTaskLog(result.task, `Synchronized Git evidence for ${result.gitEvidence.branch}@${result.gitEvidence.commit.slice(0, 12)}.`, 'update');
      saveTask(result.task);
      return res.json(toMutationResponse(req, result.task, {
        task: result.task,
        gitEvidence: result.gitEvidence,
        verificationEvidence: result.verificationEvidence,
        workflowWarnings: buildTaskGitWarnings(result.task),
      }, {
        gitEvidence: result.gitEvidence,
        verificationEvidence: result.verificationEvidence,
        workflowWarnings: buildTaskGitWarnings(result.task),
      }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });

  app.post('/api/tasks/:id/submit-review', (req, res) => {
    try {
      const task = findTaskByIdentifier(deps.state, req.params.id);
      if (!task) return res.status(404).json({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found.' } });
      if (task.status === 'in-progress' && !canOverrideTaskLock(task, req.body, req.query, req.headers['x-agent-request'])) {
        return res.status(403).json({ error: { code: 'TASK_LOCKED', message: 'Task is locked by an agent. Set isAgentRequest or emergency when authorized.' } });
      }

      const evaluation = evaluateReviewSubmission(deps.state, task, req.body || {});
      const evidenceBranchMismatch = evaluation.blockers.some((blocker) => blocker.code === 'TASK_BRANCH_MISMATCH');
      const updatedTask = {
        ...task,
        ...(evaluation.gitEvidence && !evidenceBranchMismatch ? { gitEvidence: evaluation.gitEvidence } : {}),
        verificationEvidence: evaluation.verificationEvidence,
        updatedAt: new Date().toISOString(),
      };

      if (evaluation.blocked) {
        appendTaskLog(updatedTask, `Review submission blocked: ${evaluation.blockers.map((entry) => entry.code).join(', ')}.`, 'update');
        saveTask(updatedTask);
        return res.status(409).json({
          blocked: true,
          reasons: evaluation.blockers,
          task: toTaskResponse(updatedTask, 'summary'),
          gitEvidence: evaluation.gitEvidence,
          verificationEvidence: evaluation.verificationEvidence,
          workflowWarnings: buildTaskGitWarnings(updatedTask),
        });
      }

      const previousStatus = updatedTask.status;
      updatedTask.status = 'ready-for-review';
      syncTaskAgentStateForStatus(updatedTask, previousStatus);
      appendTaskLog(updatedTask, `Submitted for review with published commit ${evaluation.gitEvidence!.commit.slice(0, 12)} and ${evaluation.verificationEvidence.length} passed verification check(s).`, 'move');
      saveTask(updatedTask);
      return res.json(toMutationResponse(req, updatedTask, {
        success: true,
        status: updatedTask.status,
        task: updatedTask,
        gitEvidence: evaluation.gitEvidence,
        verificationEvidence: evaluation.verificationEvidence,
        workflowWarnings: buildTaskGitWarnings(updatedTask),
      }, {
        gitEvidence: evaluation.gitEvidence,
        verificationEvidence: evaluation.verificationEvidence,
        workflowWarnings: buildTaskGitWarnings(updatedTask),
      }));
    } catch (error) {
      return sendApiError(res, error);
    }
  });
}
