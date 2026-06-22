import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCorrelationId } from './services/api';
import { getCapabilityCatalog, getMcpToolList, getToolDefinitionByName } from './contracts/devflowContract';
import { recordToolCall } from './services/mcpToolMonitor';

function buildMcpToolError(params: {
  toolName: string;
  method: string;
  url: string;
  apiBaseUrl: string;
  code: string;
  message: string;
  correlationId: string;
  retryable: boolean;
  guidance?: string;
  cause?: unknown;
  status?: number;
}) {
  return {
    code: params.code,
    message: params.message,
    details: {
      toolName: params.toolName,
      method: params.method,
      attemptedUrl: params.url,
      apiBaseUrl: params.apiBaseUrl,
      ...(params.status !== undefined ? { status: params.status } : {}),
      guidance:
        params.guidance ||
        `Please ensure the DevFlow API server is running at ${params.apiBaseUrl}. If running locally, check if 'npm run dev' or the tray app is running.`,
      ...(params.cause instanceof Error
        ? { cause: { name: params.cause.name, message: params.cause.message } }
        : {}),
    },
    retryable: params.retryable,
    correlationId: params.correlationId,
  };
}

function buildMcpFetchError(params: {
  toolName: string;
  method: string;
  url: string;
  apiBaseUrl: string;
  error: any;
  correlationId: string;
}) {
  const isTimeout = params.error?.name === 'AbortError';
  return buildMcpToolError({
    toolName: params.toolName,
    method: params.method,
    url: params.url,
    apiBaseUrl: params.apiBaseUrl,
    code: isTimeout ? 'TIMEOUT' : 'FETCH_FAILED',
    message: isTimeout
      ? `Request to DevFlow API timed out after 30s.`
      : `Failed to connect to DevFlow API: ${params.error?.message || 'Unknown network error'}`,
    retryable: true,
    correlationId: params.correlationId,
    cause: params.error,
  });
}

async function executeHttpRequest(
  baseUrl: string,
  request: { method: string; path: string; body?: unknown; headers?: Record<string, string> },
  correlationId: string,
  toolName: string
) {
  const url = `${baseUrl}${request.path}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'x-correlation-id': correlationId,
    ...(request.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(request.headers || {}),
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/json')) {
      const rawBody = await response.text();
      try {
        const parsedBody = rawBody.trim().length > 0 ? JSON.parse(rawBody) : null;
        return { response, parsedBody, durationMs };
      } catch (error) {
        const parsedBody = {
          error: buildMcpToolError({
            toolName,
            method: request.method,
            url,
            apiBaseUrl: baseUrl,
            code: 'INVALID_JSON_RESPONSE',
            message: `DevFlow API returned invalid JSON for ${toolName}.`,
            retryable: true,
            correlationId,
            cause: error,
            status: response.status,
            guidance: `The DevFlow API responded but returned malformed JSON. Check server logs for ${correlationId}, then retry the tool call.`,
          }),
        };
        return { response: { ok: false, status: 502 } as any, parsedBody, durationMs };
      }
    }

    const parsedBody = await response.text();
    if (response.ok) {
      return {
        response: { ok: false, status: 502 } as any,
        parsedBody: {
          error: buildMcpToolError({
            toolName,
            method: request.method,
            url,
            apiBaseUrl: baseUrl,
            code: 'NON_JSON_RESPONSE',
            message: `DevFlow API returned a non-JSON response for ${toolName}.`,
            retryable: true,
            correlationId,
            status: response.status,
            guidance: `MCP tools expect JSON from the DevFlow API. Check the endpoint response and server logs for ${correlationId}.`,
          }),
        },
        durationMs,
      };
    }

    return { response, parsedBody, durationMs };
  } catch (error: any) {
    const durationMs = Date.now() - startedAt;
    const parsedBody = {
      error: buildMcpFetchError({
        toolName,
        method: request.method,
        url,
        apiBaseUrl: baseUrl,
        error,
        correlationId,
      }),
    };
    return { response: { ok: false, status: 503 } as any, parsedBody, durationMs };
  } finally {
    clearTimeout(timeoutId);
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

    let httpRequest;
    if (tool.executionPolicy?.mode === 'job') {
      httpRequest = { method: 'POST', path: '/api/tool-jobs', body: { toolName, args } };
    } else {
      httpRequest = tool.buildHttpRequest(args);
    }
    const { response, parsedBody, durationMs } = await executeHttpRequest(baseUrl, httpRequest as any, correlationId, toolName);
    recordToolCall({ toolName, args, status: response.status, durationMs });
    console.log(`[mcp] cid=${correlationId} tool=${toolName} status=${response.status} durationMs=${durationMs}`);

    if (!response.ok) {
      const normalizedError = parsedBody && typeof parsedBody === 'object' && 'error' in parsedBody
        ? (parsedBody as any).error
        : buildMcpToolError({
            toolName,
            method: httpRequest.method,
            url: `${baseUrl}${httpRequest.path}`,
            apiBaseUrl: baseUrl,
            code: 'HTTP_ERROR',
            message: typeof parsedBody === 'string' ? parsedBody : `HTTP ${response.status}`,
            retryable: response.status >= 500,
            correlationId,
            status: response.status,
            guidance: response.status >= 500
              ? `DevFlow API returned a server error. Check the API logs for ${correlationId}, then retry.`
              : `DevFlow API rejected the request. Check the tool arguments and endpoint mapping before retrying.`,
          });

      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify(normalizedError, null, 2) }],
      };
    }

    return toMcpTextPayload(parsedBody);
  });

  return server;
}
