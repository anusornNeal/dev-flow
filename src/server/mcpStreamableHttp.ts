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

export const NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS: McpStreamableHttpLifecycleHooks = {};

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

export function createStatelessMcpHttpHandler(
  apiBaseUrl: string,
  profileOverride?: string,
  hooks: McpStreamableHttpLifecycleHooks = NOOP_MCP_STREAMABLE_HTTP_LIFECYCLE_HOOKS,
) {
  return async (req: any, res: any, next?: (error?: unknown) => void) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: stateless DevFlow MCP accepts POST requests only.' },
        id: null,
      });
    }

    const mcpServer = createDevFlowMcpServer(apiBaseUrl, profileOverride);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await runTimedPhase(hooks, 'connect', () => mcpServer.connect(transport));
      await runTimedPhase(hooks, 'handle', () => transport.handleRequest(req, res, req.body));
    } catch (error) {
      console.error('MCP Streamable HTTP request error:', error);
      if (!res.headersSent) {
        return res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal Streamable HTTP transport error.' },
          id: null,
        });
      }
      next?.(error);
    } finally {
      await runTimedPhase(hooks, 'close', () => transport.close()).catch(() => {});
    }
  };
}
