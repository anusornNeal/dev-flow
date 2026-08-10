import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDevFlowMcpServer } from './mcp';

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

export interface McpStreamableHttpSessionOptions {
  idleTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
  sessionIdGenerator?: () => string;  requestHooks?: (req: any, res: any) => McpStreamableHttpLifecycleHooks | undefined;
}

export const NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS: McpStreamableHttpLifecycleHooks = {};

const DEFAULT_SESSION_IDLE_TTL_MS = 5 * 60 * 1000;
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

  const closeSession = async (entry: SessionEntry, requestHooks: McpStreamableHttpLifecycleHooks = hooks) => {
    if (entry.closed) return;
    entry.closed = true;
    if (entry.sessionId && sessions.get(entry.sessionId) === entry) sessions.delete(entry.sessionId);
    await runTimedPhase(requestHooks, 'close', () => entry.transport.close()).catch(() => {});
  };

  const pruneIdleSessions = async (requestHooks: McpStreamableHttpLifecycleHooks = hooks) => {
    const cutoff = now() - idleTtlMs;
    const expired = Array.from(sessions.values())
      .filter((entry) => !entry.closed && entry.inFlight === 0 && entry.lastUsedAt <= cutoff)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of expired) await closeSession(entry, requestHooks);
  };

  const ensureCapacity = async (requestHooks: McpStreamableHttpLifecycleHooks = hooks) => {
    await pruneIdleSessions(requestHooks);
    if (sessions.size < maxSessions) return true;
    const idle = Array.from(sessions.values())
      .filter((entry) => !entry.closed && entry.inFlight === 0)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    for (const entry of idle) {
      await closeSession(entry, requestHooks);
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

    const requestHooks = options.requestHooks?.(req, res) || hooks;
    await pruneIdleSessions(requestHooks);
    const requestedSessionId = requestSessionId(req);
    let entry = requestedSessionId ? sessions.get(requestedSessionId) : undefined;
    if (method === 'GET' && !requestedSessionId) {
      return res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'MCP session id is required to open the Streamable HTTP GET stream.' },
        id: null,
      });
    }
    if (requestedSessionId && !entry) {
      return res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'MCP session not found or expired. Reinitialize a fresh session.' },
        id: null,
      });
    }

    const isNewSession = !entry;
    if (!entry) {
      if (!(await ensureCapacity(requestHooks))) {
        return res.status(503).json({
          jsonrpc: '2.0',
          error: { code: -32002, message: 'MCP session capacity is temporarily exhausted.' },
          id: null,
        });
      }
      const mcpServer = createDevFlowMcpServer(apiBaseUrl, profileOverride);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: nextSessionId,
        enableJsonResponse: true,
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
        await closeSession(entry, requestHooks);
        throw error;
      }
    }

    entry.inFlight += 1;
    entry.lastUsedAt = now();
    try {
      await runTimedPhase(requestHooks, 'handle', () => entry!.transport.handleRequest(req, res, req.body));
      if (isNewSession) {
        const generatedSessionId = String(entry.transport.sessionId || '').trim();
        if (generatedSessionId) {
          entry.sessionId = generatedSessionId;
          sessions.set(generatedSessionId, entry);
        } else {
          await closeSession(entry, requestHooks);
        }
      }
    } catch (error) {
      console.error('MCP Streamable HTTP request error:', error);
      await closeSession(entry, requestHooks);
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal Streamable HTTP transport error.' },
          id: null,
        });
      }
      next?.(error);
    } finally {
      entry.inFlight = Math.max(0, entry.inFlight - 1);
      entry.lastUsedAt = now();
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
