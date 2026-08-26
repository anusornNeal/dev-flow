import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDevFlowMcpServer } from './mcp';
import { runMcpRequestScope } from './mcpRequestContext';

export type McpStreamableHttpLifecyclePhase = 'connect' | 'handle' | 'close';
export type McpStreamableHttpLifecycleOutcome = 'success' | 'error';

export interface McpStreamableHttpLifecycleTiming {
  phase: McpStreamableHttpLifecyclePhase;
  durationMs: number;
  outcome: McpStreamableHttpLifecycleOutcome;
}

export interface McpStreamableHttpLifecycleHooks {
  onTiming?: (event: McpStreamableHttpLifecycleTiming) => void;
}

export type McpStreamableHttpSessionLifecycleKind =
  | 'request-start'
  | 'request-end'
  | 'created'
  | 'ttl-expired'
  | 'error-closed'
  | 'capacity-evicted'
  | 'stale-session-404';

// Trace metadata intentionally excludes protocol session identifiers.
export interface McpStreamableHttpRequestTraceContext {
  correlationId?: string | null;
  runtimeInstanceId?: string | null;
}

export interface McpStreamableHttpLifecycleMetadata extends McpStreamableHttpRequestTraceContext {
  outcome?: 'success' | 'error' | 'aborted' | 'unknown';
  statusCode?: number | null;
  totalMs?: number | null;
}

export interface McpStreamableHttpSessionLifecycleEvent extends McpStreamableHttpLifecycleMetadata {
  kind: McpStreamableHttpSessionLifecycleKind;
  timestamp: number;
  activeSessions: number;
  idleSessions: number;
}

export interface McpStreamableHttpSessionOptions {
  idleTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  sessionIdGenerator?: () => string;
  requestHooks?: (req: any, res: any) => McpStreamableHttpLifecycleHooks | undefined;
  requestTraceContext?: (req: any, res: any) => McpStreamableHttpRequestTraceContext | undefined;
  onSessionLifecycle?: (event: McpStreamableHttpSessionLifecycleEvent) => void;
}

export const NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS: McpStreamableHttpLifecycleHooks = {};

const DEFAULT_SESSION_IDLE_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 64;

type SessionEntry = {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  lastUsedAt: number;
  inFlight: number;
  closed: boolean;
};

function emitTiming(
  hooks: McpStreamableHttpLifecycleHooks,
  phase: McpStreamableHttpLifecyclePhase,
  startedAt: number,
  outcome: McpStreamableHttpLifecycleOutcome,
) {
  try {
    hooks.onTiming?.({
      phase,
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
    });
  } catch {
    // Telemetry must never alter transport behavior.
  }
}

async function runTimedPhase<T>(
  hooks: McpStreamableHttpLifecycleHooks,
  phase: McpStreamableHttpLifecyclePhase,
  operation: () => Promise<T>,
) {
  const startedAt = Date.now();
  try {
    const result = await operation();
    emitTiming(hooks, phase, startedAt, 'success');
    return result;
  } catch (error) {
    emitTiming(hooks, phase, startedAt, 'error');
    throw error;
  }
}

function boundedPositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function requestSessionId(req: any) {
  const value = req?.headers?.['mcp-session-id'];
  return Array.isArray(value) ? String(value[0] || '').trim() : String(value || '').trim();
}

function resolveRequestHooks(
  options: McpStreamableHttpSessionOptions,
  req: any,
  res: any,
  fallback: McpStreamableHttpLifecycleHooks,
) {
  try {
    return options.requestHooks?.(req, res) || fallback;
  } catch {
    // Telemetry must never alter transport behavior.
    return fallback;
  }
}

function resolveRequestTraceContext(options: McpStreamableHttpSessionOptions, req: any, res: any) {
  try {
    return options.requestTraceContext?.(req, res) || {};
  } catch {
    // Telemetry must never alter transport behavior.
    return {};
  }
}

export function createReusableMcpHttpHandler(
  apiBaseUrl: string,
  profileOverride?: string,
  hooks: McpStreamableHttpLifecycleHooks = NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS,
  options: McpStreamableHttpSessionOptions = {},
) {
  const sessions = new Map<string, SessionEntry>();
  const now = options.now || Date.now;
  const idleTtlMs = boundedPositiveInt(options.idleTtlMs, DEFAULT_SESSION_IDLE_TTL_MS, 24 * 60 * 60 * 1000);
  const maxSessions = boundedPositiveInt(options.maxSessions, DEFAULT_MAX_SESSIONS, 1024);
  const configuredSessionIdGenerator = options.sessionIdGenerator || randomUUID;

  const emitSessionLifecycle = (
    kind: McpStreamableHttpSessionLifecycleKind,
    metadata: McpStreamableHttpLifecycleMetadata = {},
  ) => {
    let activeSessions = 0;
    let idleSessions = 0;
    for (const entry of sessions.values()) {
      if (entry.closed) continue;
      if (entry.inFlight > 0) activeSessions += 1;
      else idleSessions += 1;
    }
    try {
      options.onSessionLifecycle?.({
        kind,
        timestamp: now(),
        activeSessions,
        idleSessions,
        ...metadata,
      });
    } catch {
      // Aggregate lifecycle telemetry must never alter transport behavior.
    }
  };

  const closeSession = async (
    entry: SessionEntry,
    reason: Extract<McpStreamableHttpSessionLifecycleKind, 'ttl-expired' | 'error-closed' | 'capacity-evicted'>,
    requestHooks: McpStreamableHttpLifecycleHooks = hooks,
    traceMetadata: McpStreamableHttpLifecycleMetadata = {},
  ) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.sessionId && sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId);
    await runTimedPhase(requestHooks, 'close', () => entry.transport.close()).catch(() => {});
    emitSessionLifecycle(reason, traceMetadata);
  };

  const pruneIdleSessions = async (
    requestHooks: McpStreamableHttpLifecycleHooks = hooks,
    traceMetadata: McpStreamableHttpLifecycleMetadata = {},
  ) => {
    const cutoff = now() - idleTtlMs;
    const expired = Array.from(sessions.values())
      .filter((entry) => !entry.closed && entry.inFlight === 0 && entry.lastUsedAt <= cutoff)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of expired) await closeSession(entry, 'ttl-expired', requestHooks, traceMetadata);
  };

  const ensureCapacity = async (
    requestHooks: McpStreamableHttpLifecycleHooks = hooks,
    traceMetadata: McpStreamableHttpLifecycleMetadata = {},
  ) => {
    await pruneIdleSessions(requestHooks, traceMetadata);
    if (sessions.size < maxSessions) return true;
    const idle = Array.from(sessions.values())
      .filter((entry) => !entry.closed && entry.inFlight === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of idle) {
      await closeSession(entry, 'capacity-evicted', requestHooks, traceMetadata);
      if (sessions.size < maxSessions) return true;
    }
    return sessions.size < maxSessions;
  };

  const nextSessionId = () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const candidate = String(configuredSessionIdGenerator() || '').trim();
      if (candidate && !sessions.has(candidate)) return candidate;
    }
    return randomUUID();
  };

  return async (req: any, res: any, next?: (error?: unknown) => void) => {
    const method = String(req.method || '').toUpperCase();
    if (method !== 'POST' && method !== 'GET') {
      res.setHeader('Allow', 'GET, POST');
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: DevFlow MCP accepts GET and POST requests.' },
        id: null,
      });
    }

    const requestStartedAt = now();
    const requestHooks = resolveRequestHooks(options, req, res, hooks);
    const requestTraceContext = resolveRequestTraceContext(options, req, res);
    let requestEnded = false;
    let requestOutcome: 'success' | 'error' | 'aborted' = 'success';
    let requestAborted = false;
    const finishRequestLifecycle = (outcome: 'success' | 'error' | 'aborted', statusCode: number | null) => {
      if (requestEnded) return;
      requestEnded = true;
      emitSessionLifecycle('request-end', {
        ...requestTraceContext,
        outcome,
        statusCode,
        totalMs: Math.max(0, now() - requestStartedAt),
      });
    };
    emitSessionLifecycle('request-start', {
      ...requestTraceContext,
      outcome: 'unknown',
      statusCode: null,
      totalMs: 0,
    });
    await pruneIdleSessions(requestHooks, requestTraceContext);
    const requestedSessionId = requestSessionId(req);
    let entry = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
    if (method === 'GET' && !requestedSessionId) {
      res.status(400);
      finishRequestLifecycle('error', 400);
      return res.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'MCP session id is required to open the Streamable HTTP GET stream.' },
        id: null,
      });
    }
    if (requestedSessionId && !entry) {
      emitSessionLifecycle('stale-session-404', { ...requestTraceContext, outcome: 'error', statusCode: 404 });
      res.status(404);
      finishRequestLifecycle('error', 404);
      return res.json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP session not found or expired. Reinitialize a fresh session.' },
        id: null,
      });
    }

    const isNewSession = !entry;
    if (!entry) {
      if (!(await ensureCapacity(requestHooks, requestTraceContext))) {
        res.status(503);
        finishRequestLifecycle('error', 503);
        return res.json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'MCP session capacity is temporarily exhausted.' },
          id: null,
        });
      }
      const mcpServer = createDevFlowMcpServer(apiBaseUrl, profileOverride);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: nextSessionId,
        enableJsonResponse: false,
      });
      entry = {
        sessionId: '',
        transport,
        lastUsedAt: now(),
        inFlight: 0,
        closed: false,
      };
      try {
        await runTimedPhase(requestHooks, 'connect', () => mcpServer.connect(transport));
      } catch (error) {
        await closeSession(entry, 'error-closed', requestHooks, { ...requestTraceContext, outcome: 'error', statusCode: 500 });
        finishRequestLifecycle('error', 500);
        throw error;
      }
    }

    entry.inFlight += 1;
    entry.lastUsedAt = now();
    const requestAbortController = new AbortController();
    const abortRequest = () => {
      if (!res.writableEnded) {
        requestAborted = true;
        requestAbortController.abort();
      }
    };
    req.once?.('aborted', abortRequest);
    req.socket?.once?.('close', abortRequest);
    res.once?.('close', abortRequest);
    try {
      await runTimedPhase(requestHooks, 'handle', () => runMcpRequestScope(
        requestAbortController.signal,
        () => entry!.transport.handleRequest(req, res, req.body),
      ));
      if (isNewSession) {
        const generatedSessionId = String(entry.transport.sessionId || '').trim();
        if (generatedSessionId) {
          entry.sessionId = generatedSessionId;
          sessions.set(generatedSessionId, entry);
          emitSessionLifecycle('created', requestTraceContext);
        } else {
          requestOutcome = 'error';
          await closeSession(entry, 'error-closed', requestHooks, {
            ...requestTraceContext,
            outcome: 'error',
            statusCode: Number(res.statusCode || 0),
          });
        }
      }
    } catch (error) {
      requestOutcome = 'error';
      console.error('MCP Streamable HTTP request error:', error);
      await closeSession(entry, 'error-closed', requestHooks, { ...requestTraceContext, outcome: 'error', statusCode: 500 });
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal Streamable HTTP transport error.' },
          id: null,
        });
      }
      next?.(error);
    } finally {
      req.removeListener?.('aborted', abortRequest);
      req.socket?.removeListener?.('close', abortRequest);
      res.removeListener?.('close', abortRequest);
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastUsedAt = now();
      finishRequestLifecycle(requestAborted ? 'aborted' : requestOutcome, Number(res.statusCode || 0));
    }
  };
}

// Backward-compatible export name retained while callers migrate from the old
// per-request stateless implementation to the reusable session lifecycle.
export function createStatelessMcpHttpHandler(
  apiBaseUrl: string,
  profileOverride?: string,
  hooks: McpStreamableHttpLifecycleHooks = NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS,
  options: McpStreamableHttpSessionOptions = {},
) {
  return createReusableMcpHttpHandler(apiBaseUrl, profileOverride, hooks, options);
}
