import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createCorrelationId } from './services/api';
import { getCapabilityCatalog, getMcpToolList, getToolDefinitionByName, isToolAllowedInProfile, resolveDevFlowToolProfile } from './contracts/devflowContract';
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

export function createStatelessMcpHttpHandler(apiBaseUrl: string) {
  return async (req: any, res: any, next?: (error?: unknown) => void) => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return res.status(405).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method Not Allowed: stateless DevFlow MCP accepts POST requests only.' },
        id: null,
      });
    }

    const mcpServer = createDevFlowMcpServer(apiBaseUrl);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
      await transport.close().catch(() => {});
    }
  };
}

export function createDevFlowMcpServer(baseUrl: string) {
  const profileResolution = resolveDevFlowToolProfile();
  const activeProfile = profileResolution.profile;
  const server = new Server(
    { name: 'dev-flow-mcp', version: getCapabilityCatalog().contractVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: getMcpToolList(activeProfile) as any }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request.params.name;
    const args = (request.params.arguments || {}) as Record<string, any>;
    const inputBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
    const tool = getToolDefinitionByName(toolName);
    const correlationId = createCorrelationId('mcp');

    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}`, retryable: false, correlationId }) }],
      };
    }

    if (!isToolAllowedInProfile(tool.name, activeProfile)) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({
          code: 'TOOL_PROFILE_MISMATCH',
          message: `Tool ${toolName} is not available in the active '${activeProfile}' MCP profile.`,
          retryable: false,
          correlationId,
          details: {
            activeProfile,
            configuredProfile: profileResolution.configured,
            fallback: profileResolution.fallback,
            guidance: 'Select DEVFLOW_MCP_TOOL_PROFILE=full or a specialized profile that contains this tool, then restart/refresh the MCP session.',
          },
        }) }],
      };
    }

    let httpRequest;
    let isAsyncJob = false;
    if (tool.executionPolicy?.mode === 'job') {
      isAsyncJob = true;
      httpRequest = { method: 'POST', path: '/api/tool-jobs', body: { toolName, args } };
    } else {
      httpRequest = tool.buildHttpRequest(args);
    }
    let { response, parsedBody, durationMs } = await executeHttpRequest(baseUrl, httpRequest as any, correlationId, toolName);

    if (isAsyncJob && response.ok && parsedBody && typeof parsedBody === 'object' && 'jobId' in parsedBody) {
      const jobId = (parsedBody as any).jobId;
      const waitStartedAt = Date.now();
      const resultRes = await executeHttpRequest(
        baseUrl,
        { method: 'GET', path: `/api/tool-jobs/${jobId}/result?waitMs=20000` },
        correlationId,
        toolName,
      );
      if (resultRes.response.ok && resultRes.parsedBody && typeof resultRes.parsedBody === 'object') {
        let resultPacket = resultRes.parsedBody as any;
        const hasWaitShape = 'ready' in resultPacket || 'status' in resultPacket || 'result' in resultPacket;

        if (!hasWaitShape) {
          const statusRes = await executeHttpRequest(
            baseUrl,
            { method: 'GET', path: `/api/tool-jobs/${jobId}` },
            correlationId,
            toolName,
          );
          if (statusRes.response.ok && statusRes.parsedBody && typeof statusRes.parsedBody === 'object') {
            const legacyStatus = (statusRes.parsedBody as any).status;
            const terminal = ['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(legacyStatus);
            if (terminal) {
              const legacyResultRes = await executeHttpRequest(
                baseUrl,
                { method: 'GET', path: `/api/tool-jobs/${jobId}/result` },
                correlationId,
                toolName,
              );
              if (legacyResultRes.response.ok && legacyResultRes.parsedBody && typeof legacyResultRes.parsedBody === 'object') {
                resultPacket = legacyResultRes.parsedBody as any;
              }
            } else {
              resultPacket = { jobId, status: legacyStatus, ready: false, result: null };
            }
          }
        }

        const status = resultPacket.status;
        const ready = 'ready' in resultPacket
          ? resultPacket.ready === true
          : ['succeeded', 'failed', 'timed_out', 'cancelled', 'interrupted'].includes(status);
        const jobResult = resultPacket.result;
        if (ready && jobResult !== null && jobResult !== undefined) {
          parsedBody = jobResult && typeof jobResult === 'object' && 'result' in jobResult
            ? (jobResult as any).result
            : jobResult;
        } else {
          parsedBody = {
            jobId,
            status,
            ready,
            result: null,
            code: resultPacket.code || (ready ? 'JOB_RESULT_NOT_READY' : 'JOB_STILL_RUNNING'),
            message: resultPacket.message || (ready
              ? `Job ${jobId} reached ${status} but no result payload was available yet.`
              : `Job ${jobId} is still ${status} after the bounded MCP wait.`),
            ...(resultPacket.nextPollAfterMs !== undefined ? { nextPollAfterMs: resultPacket.nextPollAfterMs } : {}),
            ...(resultPacket.recommendedWaitMs !== undefined ? { recommendedWaitMs: resultPacket.recommendedWaitMs } : {}),
            ...(resultPacket.nextAction ? { nextAction: resultPacket.nextAction } : {}),
          };
        }
        durationMs += Date.now() - waitStartedAt;
      }
    }
    const responseBytes = Buffer.byteLength(typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody ?? null), 'utf8');
    recordToolCall({
      toolName,
      args,
      status: response.status,
      durationMs,
      responseBytes,
      inputBytes,
      cacheHit: parsedBody && typeof parsedBody === 'object' && (parsedBody as any).cache?.hit === true,
      processSpawns: parsedBody && typeof parsedBody === 'object' ? Number((parsedBody as any).processSpawns || 0) : 0,
      responseMode: parsedBody && typeof parsedBody === 'object'
        ? String((parsedBody as any).responseMode || args.responseMode || '') || undefined
        : String(args.responseMode || '') || undefined,
      responseTruncated: parsedBody && typeof parsedBody === 'object'
        ? ((parsedBody as any).truncated === true || (parsedBody as any).previewOmitted === true)
        : false,
    });
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
