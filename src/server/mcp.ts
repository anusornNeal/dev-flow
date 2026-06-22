import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCorrelationId } from './services/api';
import { getCapabilityCatalog, getMcpToolList, getToolDefinitionByName } from './contracts/devflowContract';
import { recordToolCall } from './services/mcpToolMonitor';

function buildMcpFetchError(params: {
  toolName: string;
  method: string;
  url: string;
  apiBaseUrl: string;
  error: any;
  correlationId: string;
}) {
  const isTimeout = params.error?.name === 'AbortError';
  const kind = isTimeout ? 'TIMEOUT' : 'FETCH_FAILED';
  const message = isTimeout
    ? `Request to DevFlow API timed out after 30s.`
    : `Failed to connect to DevFlow API: ${params.error?.message || 'Unknown network error'}`;

  return {
    code: kind,
    message,
    details: {
      toolName: params.toolName,
      method: params.method,
      attemptedUrl: params.url,
      apiBaseUrl: params.apiBaseUrl,
      guidance: `Please ensure the DevFlow API server is running at ${params.apiBaseUrl}. If running locally, check if 'npm run dev' or the tray app is running.`,
    },
    retryable: true,
    correlationId: params.correlationId,
  };
}

async function executeHttpRequest(
  baseUrl: string,
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
  correlationId: string,
  toolName: string
) {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-correlation-id': correlationId,
    ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(request.headers || {}),
  };
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    const response = await fetch(`${baseUrl}${request.path}`, {
      method: request.method,
      headers,
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';
    const parsedBody = contentType.includes('application/json')
      ? await response.json().catch(() => null)
      : await response.text();

    return { response, parsedBody, durationMs };
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const parsedBody = {
      error: buildMcpFetchError({
        toolName,
        method: request.method,
        url: `${baseUrl}${request.path}`,
        apiBaseUrl: baseUrl,
        error,
        correlationId,
      }),
    };
    return { response: { ok: false, status: 503 } as any, parsedBody, durationMs };
  }
}

function toMcpTextPayload(data: unknown) {
  if (typeof data === 'string') {
    return { content: [{ type: 'text', text: data }] };
  }

  // MCP 2025 spec: tools with an outputSchema must return structuredContent alongside text content.
  // Provide a best-effort object form (capped at one level of nesting) so the SDK validator passes.
  const structuredContent = data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function createDevFlowMcpServer(baseUrl: string) {
  const server = new Server(
    { name: 'dev-flow-mcp', version: getCapabilityCatalog().contractVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getMcpToolList() as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, any>;
    const tool = getToolDefinitionByName(toolName);
    const correlationId = createCorrelationId('mcp');

    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}`, retryable: false, correlationId }) }],
      };
    }

    const httpRequest = tool.buildHttpRequest(args);
    const { response, parsedBody, durationMs } = await executeHttpRequest(baseUrl, httpRequest, correlationId, toolName);
    recordToolCall({ toolName, args, status: response.status, durationMs });
    console.log(`[mcp] cid=${correlationId} tool=${toolName} status=${response.status} durationMs=${durationMs}`);

    if (!response.ok) {
      const normalizedError = parsedBody && typeof parsedBody === 'object' && 'error' in parsedBody
        ? (parsedBody as any).error
        : {
            code: 'HTTP_ERROR',
            message: typeof parsedBody === 'string' ? parsedBody : `HTTP ${response.status}`,
            retryable: response.status >= 500,
            correlationId,
          };

      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(normalizedError, null, 2) }],
      };
    }

    return toMcpTextPayload(parsedBody);
  });

  return server;
}
