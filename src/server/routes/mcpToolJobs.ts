import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { enqueueToolJob, getToolJobStatus, cancelToolJob, getJobMetrics, getQueueMetrics } from '../services/mcpToolJobService';
import { readJobLog, readJobResult } from '../repositories/mcpToolJobRepository';
import { createApiError } from '../services/api';
import { getToolDefinitionByName } from '../contracts/devflowContract';

export function registerMcpToolJobRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/queue-metrics', (req, res, next) => {
    try {
      res.json(getQueueMetrics());
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/tool-jobs', (req, res, next) => {
    try {
      const { toolName, args } = req.body;
      if (!toolName || !args) {
        throw createApiError(400, 'BAD_REQUEST', 'toolName and args are required.');
      }
      
      const def = getToolDefinitionByName(toolName);
      if (!def) {
        throw createApiError(404, 'UNKNOWN_TOOL', `Unknown tool: ${toolName}`);
      }
      if (def.executionPolicy?.mode !== 'job') {
        throw createApiError(400, 'TOOL_NOT_ASYNC', `Tool '${toolName}' is not configured for async job execution.`);
      }
      
      const kind = def.executionPolicy?.jobKind || 'repo-command';
      const jobInfo = enqueueToolJob(deps.state, toolName, args, kind);
      
      res.json(jobInfo);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/tool-jobs/:jobId', (req, res, next) => {
    try {
      const status = getToolJobStatus(req.params.jobId);
      if (!status) {
        throw createApiError(404, 'JOB_NOT_FOUND', `Job not found: ${req.params.jobId}`);
      }
      res.json(status);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/tool-jobs/:jobId/log', (req, res, next) => {
    try {
      const status = getToolJobStatus(req.params.jobId);
      if (!status) {
        throw createApiError(404, 'JOB_NOT_FOUND', `Job not found: ${req.params.jobId}`);
      }
      const stream = (req.query.stream as 'stdout' | 'stderr' | 'both') || 'both';
      const log = readJobLog(req.params.jobId, stream);
      res.json({ jobId: req.params.jobId, status: status.status, stream, ...log });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/tool-jobs/:jobId/result', (req, res, next) => {
    try {
      const status = getToolJobStatus(req.params.jobId);
      if (!status) {
        throw createApiError(404, 'JOB_NOT_FOUND', `Job not found: ${req.params.jobId}`);
      }
      const terminal = status.status === 'succeeded' || status.status === 'failed' || status.status === 'timed_out' || status.status === 'cancelled';
      const result = readJobResult(req.params.jobId);
      const safeResult = result || {
        result: {
          ok: false,
          status: terminal ? status.status : 'pending',
          code: terminal ? 'JOB_RESULT_UNAVAILABLE' : 'JOB_RESULT_PENDING',
          message: terminal ? 'The job finished before a result payload was readable.' : 'The job has not produced a result payload yet.',
          jobId: req.params.jobId,
          failureSummary: status.failureSummary || null,
        },
      };
      res.json({
        jobId: req.params.jobId,
        status: status.status,
        ready: terminal,
        result: safeResult,
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/tool-jobs/:jobId/cancel', (req, res, next) => {
    try {
      const status = getToolJobStatus(req.params.jobId);
      if (!status) {
        throw createApiError(404, 'JOB_NOT_FOUND', `Job not found: ${req.params.jobId}`);
      }
      const success = cancelToolJob(req.params.jobId);
      res.json({ jobId: req.params.jobId, cancelled: success, previousStatus: status.status });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/tool-jobs-metrics', (req, res, next) => {
    try {
      res.json(getJobMetrics());
    } catch (error) {
      next(error);
    }
  });
}
