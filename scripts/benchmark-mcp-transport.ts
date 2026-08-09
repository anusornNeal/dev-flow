import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createDevFlowMcpServer, createStatelessMcpHttpHandler } from '../src/server/mcp.js';

export type BenchmarkOptions = {
  coldSamples?: number;
  warmSamples?: number;
};

type LatencyStats = {
  samples: number;
  p50Ms: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
};

type ProtocolMeasurements = {
  transport: 'streamable-http' | 'legacy-sse';
  endpoint: '/mcp' | '/sse';
  cold: {
    initialize: LatencyStats;
    listTools: LatencyStats;
    callTool: LatencyStats;
  };
  warm: {
    listTools: LatencyStats;
    callTool: LatencyStats;
  };
  payload: {
    toolCount: number;
    toolListJsonBytes: number;
    toolSchemasJsonBytes: number;
    callResultJsonBytes: number;
  };
};

const DEFAULT_COLD_SAMPLES = 8;
const DEFAULT_WARM_SAMPLES = 30;
const BENCHMARK_TOOL_NAME = 'get_tool_schema';
const BENCHMARK_TOOL_ARGS = { toolName: BENCHMARK_TOOL_NAME };

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values: number[]): LatencyStats {
  if (values.length === 0) {
    return { samples: 0, p50Ms: 0, p95Ms: 0, minMs: 0, maxMs: 0, meanMs: 0 };
  }
  return {
    samples: values.length,
    p50Ms: round(percentile(values, 50)),
    p95Ms: round(percentile(values, 95)),
    minMs: round(Math.min(...values)),
    maxMs: round(Math.max(...values)),
    meanMs: round(values.reduce((sum, value) => sum + value, 0) / values.length),
  };
}

async function measure<T>(operation: () => Promise<T>) {
  const startedAt = performance.now();
  const value = await operation();
  return { value, durationMs: performance.now() - startedAt };
}

function positiveSampleCount(value: number | undefined, fallback: number, label: string) {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0 || resolved > 1000) {
    throw new Error(`${label} must be an integer from 1 to 1000.`);
  }
  return resolved;
}

function payloadMetrics(listed: any, callResult: any) {
  const tools = Array.isArray(listed?.tools) ? listed.tools : [];
  const schemas = tools.map((tool: any) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
  }));
  return {
    toolCount: tools.length,
    toolListJsonBytes: Buffer.byteLength(JSON.stringify(listed ?? null), 'utf8'),
    toolSchemasJsonBytes: Buffer.byteLength(JSON.stringify(schemas), 'utf8'),
    callResultJsonBytes: Buffer.byteLength(JSON.stringify(callResult ?? null), 'utf8'),
  };
}

function compareLatency(candidate: LatencyStats, baseline: LatencyStats) {
  const ratio = (candidateValue: number, baselineValue: number) => baselineValue > 0 ? round(candidateValue / baselineValue) : null;
  return {
    p50DeltaMs: round(candidate.p50Ms - baseline.p50Ms),
    p95DeltaMs: round(candidate.p95Ms - baseline.p95Ms),
    p50Ratio: ratio(candidate.p50Ms, baseline.p50Ms),
    p95Ratio: ratio(candidate.p95Ms, baseline.p95Ms),
  };
}

async function startBenchmarkServer() {
  const app = express();
  app.use('/mcp', express.json({ limit: '1mb' }));

  app.get('/api/capabilities/tools/:toolName', (req, res) => {
    res.json({
      name: req.params.toolName,
      description: 'Benchmark fixture response.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });
  });

  let apiBaseUrl = '';
  app.post('/mcp', (req, res, next) => createStatelessMcpHttpHandler(apiBaseUrl, 'full')(req, res, next));

  const activeSseTransports = new Map<string, SSEServerTransport>();
  app.get('/sse', async (_req, res) => {
    const mcpServer = createDevFlowMcpServer(apiBaseUrl, 'full');
    const transport = new SSEServerTransport('/sse', res);
    activeSseTransports.set(transport.sessionId, transport);
    res.on('close', () => activeSseTransports.delete(transport.sessionId));
    try {
      await mcpServer.connect(transport);
    } catch (error) {
      activeSseTransports.delete(transport.sessionId);
      if (!res.headersSent) res.status(500).end();
      else res.end();
      console.error('Benchmark SSE connect failed:', error);
    }
  });
  app.post('/sse', async (req, res) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = activeSseTransports.get(sessionId);
    if (!transport) {
      res.status(400).json({ error: 'No active benchmark SSE session.' });
      return;
    }
    await transport.handlePostMessage(req, res);
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind MCP transport benchmark server.');
  apiBaseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl: apiBaseUrl,
    close: async () => {
      await Promise.all([...activeSseTransports.values()].map((transport) => transport.close().catch(() => {})));
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function streamableClient(baseUrl: string, label: string) {
  const client = new Client({ name: `benchmark-mcp-${label}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl));
  return { client, transport };
}

function sseClient(baseUrl: string, label: string) {
  const client = new Client({ name: `benchmark-sse-${label}`, version: '1.0.0' });
  const transport = new SSEClientTransport(new URL('/sse', baseUrl));
  return { client, transport };
}

async function benchmarkProtocol(
  baseUrl: string,
  transport: 'streamable-http' | 'legacy-sse',
  coldSamples: number,
  warmSamples: number,
): Promise<ProtocolMeasurements> {
  const createClient = transport === 'streamable-http' ? streamableClient : sseClient;
  const initializeSamples: number[] = [];
  const coldListSamples: number[] = [];
  const coldCallSamples: number[] = [];
  let listedPayload: any = null;
  let callPayload: any = null;

  for (let index = 0; index < coldSamples; index += 1) {
    const current = createClient(baseUrl, `cold-${index}`);
    try {
      initializeSamples.push((await measure(() => current.client.connect(current.transport))).durationMs);
      const listed = await measure(() => current.client.listTools());
      coldListSamples.push(listed.durationMs);
      listedPayload ??= listed.value;
      const called = await measure(() => current.client.callTool({ name: BENCHMARK_TOOL_NAME, arguments: BENCHMARK_TOOL_ARGS }));
      coldCallSamples.push(called.durationMs);
      callPayload ??= called.value;
    } finally {
      await current.client.close().catch(() => {});
    }
  }

  const warmListSamples: number[] = [];
  const warmCallSamples: number[] = [];
  const warm = createClient(baseUrl, 'warm');
  try {
    await warm.client.connect(warm.transport);
    await warm.client.listTools();
    await warm.client.callTool({ name: BENCHMARK_TOOL_NAME, arguments: BENCHMARK_TOOL_ARGS });
    for (let index = 0; index < warmSamples; index += 1) {
      const listed = await measure(() => warm.client.listTools());
      warmListSamples.push(listed.durationMs);
      listedPayload ??= listed.value;
      const called = await measure(() => warm.client.callTool({ name: BENCHMARK_TOOL_NAME, arguments: BENCHMARK_TOOL_ARGS }));
      warmCallSamples.push(called.durationMs);
      callPayload ??= called.value;
    }
  } finally {
    await warm.client.close().catch(() => {});
  }

  return {
    transport,
    endpoint: transport === 'streamable-http' ? '/mcp' : '/sse',
    cold: {
      initialize: summarize(initializeSamples),
      listTools: summarize(coldListSamples),
      callTool: summarize(coldCallSamples),
    },
    warm: {
      listTools: summarize(warmListSamples),
      callTool: summarize(warmCallSamples),
    },
    payload: payloadMetrics(listedPayload, callPayload),
  };
}

export async function runMcpTransportBenchmark(options: BenchmarkOptions = {}) {
  const coldSamples = positiveSampleCount(options.coldSamples, DEFAULT_COLD_SAMPLES, 'coldSamples');
  const warmSamples = positiveSampleCount(options.warmSamples, DEFAULT_WARM_SAMPLES, 'warmSamples');
  const fixture = await startBenchmarkServer();

  try {
    const streamableHttp = await benchmarkProtocol(fixture.baseUrl, 'streamable-http', coldSamples, warmSamples);
    const legacySse = await benchmarkProtocol(fixture.baseUrl, 'legacy-sse', coldSamples, warmSamples);
    return {
      schemaVersion: 1 as const,
      benchmark: 'devflow-mcp-transport-local' as const,
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      config: {
        coldSamples,
        warmSamples,
        toolName: BENCHMARK_TOOL_NAME,
      },
      protocols: {
        streamableHttp,
        legacySse,
      },
      comparison: {
        baseline: 'legacySse' as const,
        candidate: 'streamableHttp' as const,
        cold: {
          initialize: compareLatency(streamableHttp.cold.initialize, legacySse.cold.initialize),
          listTools: compareLatency(streamableHttp.cold.listTools, legacySse.cold.listTools),
          callTool: compareLatency(streamableHttp.cold.callTool, legacySse.cold.callTool),
        },
        warm: {
          listTools: compareLatency(streamableHttp.warm.listTools, legacySse.warm.listTools),
          callTool: compareLatency(streamableHttp.warm.callTool, legacySse.warm.callTool),
        },
      },
      limitations: [
        'Measures localhost/loopback protocol and DevFlow server overhead inside one Node.js process; machine load can affect results.',
        'Does not measure ChatGPT model/tool-selection time, ngrok or other tunnel latency, internet routing, or platform-side MCP registry/serialization overhead.',
        'Use repeated runs on the same machine and revision for before/after engineering comparisons; final pass/fail latency thresholds belong to the integration gate.',
      ],
    };
  } finally {
    await fixture.close();
  }
}

function readCliSampleArg(name: string, envName: string) {
  const prefix = `--${name}=`;
  const arg = process.argv.slice(2).find((entry) => entry.startsWith(prefix));
  const raw = arg ? arg.slice(prefix.length) : process.env[envName];
  return raw === undefined ? undefined : Number(raw);
}

async function main() {
  const originalLog = console.log;
  console.log = (...args: unknown[]) => console.error(...args);
  try {
    const result = await runMcpTransportBenchmark({
      coldSamples: readCliSampleArg('cold-samples', 'DEVFLOW_MCP_BENCH_COLD_SAMPLES'),
      warmSamples: readCliSampleArg('warm-samples', 'DEVFLOW_MCP_BENCH_WARM_SAMPLES'),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    console.log = originalLog;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : error);
    process.exitCode = 1;
  });
}
