import { randomUUID } from 'node:crypto';
import {
  DEVFLOW_RESTART_ACK_DELAY_MS,
  DEVFLOW_RESTART_EXIT_CODE,
  DEVFLOW_RESTART_EXTERNAL_TRANSPORT_POLICY,
  DEVFLOW_RESTART_RUNTIME_SCOPE,
  DEVFLOW_RESTART_SUPERVISOR_ENV,
  DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV,
  DEVFLOW_RESTART_SUPERVISOR_START_ALL,
  isDevFlowRestartPending,
  markDevFlowRestartFailed,
  readDevFlowRestartState,
  writeDevFlowRestartState,
} from '../../lib/devFlowRestart';
import { createApiError } from './api';
import { getQueueMetrics } from './mcpToolJobService';
import { getMcpRestartActivitySnapshot } from './mcpTransportMonitor';

const PENDING_RESTART_TTL_MS = 2 * 60 * 1000;

type RestartServiceDeps = {
  env?: NodeJS.ProcessEnv;
  pid?: number;
  now?: () => Date;
  uuid?: () => string;
  getQueueMetrics?: typeof getQueueMetrics;
  getMcpRestartActivitySnapshot?: typeof getMcpRestartActivitySnapshot;
};

function normalizeReason(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const reason = value.trim();
  return reason ? reason.slice(0, 200) : undefined;
}

function isFreshPendingRestart(updatedAt: string, nowMs: number) {
  const updatedMs = Date.parse(updatedAt);
  return Number.isFinite(updatedMs) && nowMs - updatedMs <= PENDING_RESTART_TTL_MS;
}

export function getDevFlowRestartStatus(args: Record<string, any> = {}) {
  const state = readDevFlowRestartState();
  if (!state) {
    return {
      available: false,
      status: 'idle',
      message: 'No DevFlow restart ticket has been recorded.',
    };
  }

  const ticket = typeof args.ticket === 'string' ? args.ticket.trim() : '';
  if (ticket && ticket !== state.ticket) {
    throw createApiError(404, 'RESTART_TICKET_NOT_FOUND', `Restart ticket '${ticket}' was not found.`, {
      affectedId: ticket,
      details: { latestTicket: state.ticket },
    });
  }

  const publicState = { ...state };
  delete publicState.supervisorToken;
  return {
    available: true,
    ...publicState,
  };
}

export function requestDevFlowRestart(
  args: Record<string, any> = {},
  deps: RestartServiceDeps = {},
) {
  const env = deps.env || process.env;
  const supervisor = String(env[DEVFLOW_RESTART_SUPERVISOR_ENV] || '').trim();
  const supervisorToken = String(env[DEVFLOW_RESTART_SUPERVISOR_TOKEN_ENV] || '').trim();
  if (supervisor !== DEVFLOW_RESTART_SUPERVISOR_START_ALL || !supervisorToken) {
    throw createApiError(
      409,
      'RESTART_UNSUPPORTED',
      'Safe DevFlow restart requires the DevFlow supervisor. Start DevFlow with npm run dev or npm run start:all; raw npm run dev:server is intentionally not restartable. The DevFlow-managed OpenAI Tunnel is outside API-only restart scope and remains running when present.',
      {
        details: {
          requiredSupervisor: DEVFLOW_RESTART_SUPERVISOR_START_ALL,
          detectedSupervisor: supervisor || null,
          supervisorTokenPresent: Boolean(supervisorToken),
        },
      },
    );
  }

  const now = (deps.now || (() => new Date()))();
  const nowMs = now.getTime();
  const metrics = (deps.getQueueMetrics || getQueueMetrics)();
  const mcpActivity = (deps.getMcpRestartActivitySnapshot || getMcpRestartActivitySnapshot)({ now: nowMs });
  const toolJobsBusy = metrics.queueLength > 0 || metrics.activeJobs > 0;
  const inFlightMcpBusy = mcpActivity.inFlightMeaningfulOperations > 0;
  const recentMcpBusy = mcpActivity.recentQuiescenceBusy;
  if (toolJobsBusy || inFlightMcpBusy || recentMcpBusy) {
    throw createApiError(
      409,
      'RESTART_BUSY',
      'DevFlow restart is blocked until active MCP work becomes quiescent.',
      {
        retryable: true,
        details: {
          blockers: {
            toolJobs: toolJobsBusy,
            inFlightMcp: inFlightMcpBusy,
            recentMcpActivity: recentMcpBusy,
          },
          queueLength: metrics.queueLength,
          activeJobs: metrics.activeJobs,
          active: metrics.active,
          queue: metrics.queue,
          mcpActivity,
          nextAction: `Wait for active work to finish and for ${mcpActivity.quiescenceWindowMs}ms of meaningful MCP quiescence, then retry restart_devflow.`,
        },
      },
    );
  }
  const existing = readDevFlowRestartState();
  if (existing && isDevFlowRestartPending(existing) && isFreshPendingRestart(existing.updatedAt, nowMs)) {
    return {
      accepted: true,
      duplicate: true,
      ticket: existing.ticket,
      status: existing.status,
      supervisor: existing.supervisor,
      runtimeScope: existing.runtimeScope,
      externalTransportPolicy: existing.externalTransportPolicy,
      exitCode: DEVFLOW_RESTART_EXIT_CODE,
      shutdownDelayMs: DEVFLOW_RESTART_ACK_DELAY_MS,
      queuePolicy: 'reject-while-busy',
    };
  }

  if (existing && isDevFlowRestartPending(existing)) {
    markDevFlowRestartFailed(existing.ticket, 'Previous restart ticket expired before the runtime became healthy.');
  }

  const requestedAt = now.toISOString();
  const ticket = `restart-${nowMs}-${(deps.uuid || randomUUID)().slice(0, 8)}`;
  const state = writeDevFlowRestartState({
    ticket,
    status: 'accepted',
    supervisor,
    supervisorToken,
    runtimeScope: DEVFLOW_RESTART_RUNTIME_SCOPE,
    externalTransportPolicy: DEVFLOW_RESTART_EXTERNAL_TRANSPORT_POLICY,
    requestedAt,
    updatedAt: requestedAt,
    requestedByPid: deps.pid ?? process.pid,
    reason: normalizeReason(args.reason),
    message: 'Restart request acknowledged. The supervisor will relaunch DevFlow after the MCP response window.',
  });

  return {
    accepted: true,
    duplicate: false,
    ticket: state.ticket,
    status: state.status,
    supervisor: state.supervisor,
    runtimeScope: state.runtimeScope,
    externalTransportPolicy: state.externalTransportPolicy,
    exitCode: DEVFLOW_RESTART_EXIT_CODE,
    shutdownDelayMs: DEVFLOW_RESTART_ACK_DELAY_MS,
    queuePolicy: 'reject-while-busy',
  };
}
