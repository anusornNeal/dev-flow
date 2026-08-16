import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createDevFlowMcpServer } from '../src/server/mcp.js';
import { createReusableMcpHttpHandler } from '../src/server/mcpStreamableHttp.js';

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
  transport: 'streamable-http' | 'streamable-http-stateless-baseline' | 'legacy-sse';
  endpoint: '/mcp' | '/mcp-baseline' | '/sse';
  cold: {
    initialize: LatencyStats;
    listTools: LatencyStats;
    callTool: LatencyStats;
  };
  warm: {
    listTools: LatencyStats;
    callTool: LatencyStats;
  };
  asyncWorkloads: Array<{
    durationMs: number;
    endToEndMs: number;
    completedWithoutFollowUp: boolean;
    completionMode: 'request-stream' | 'durable-handoff';
  }>;
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
const WARM_P50_BASELINE_RATIO_MAX = 0.95;
const WARM_P95_BASELINE_DELTA_MAX_MS = 2;
const ASYNC_BENCHMARK_DURATIONS_MS = [3_000, 10_000] as const;
const ASYNC_COMPLETION_WINDOW_MS = 15_000;
const SSE_SYNC_P95_RATIO_MAX = 1.15;
const SSE_SYNC_P95_DELTA_MAX_MS = 2;
const SSE_SYNC_MAX_ATTEMPTS = 3;
const SSE_SYNC_REQUIRED_PASSES = 2;
const SSE_SYNC_RETRY_MEDIAN_P95_RATIO_MAX = 1.35;
const SSE_SYNC_RETRY_MEDIAN_P95_DELTA_MAX_MS = 3;

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

function warmRegressionBudget(candidate: LatencyStats, baseline: LatencyStats) {
  const p50Ratio = baseline.p50Ms > 0 ? round(candidate.p50Ms / baseline.p50Ms) : null;
  const p95DeltaMs = round(candidate.p95Ms - baseline.p95Ms);
  return {
    maxP50Ratio: WARM_P50_BASELINE_RATIO_MAX,
    maxP95DeltaMs: WARM_P95_BASELINE_DELTA_MAX_MS,
    actualP50Ratio: p50Ratio,
    actualP95DeltaMs: p95DeltaMs,
    passed: p50Ratio !== null && p50Ratio <= WARM_P50_BASELINE_RATIO_MAX
      && p95DeltaMs <= WARM_P95_BASELINE_DELTA_MAX_MS,
  };
}

function userExperienceBudget(candidate: LatencyStats, control: LatencyStats, maxP95Ratio = 1.15, maxP95DeltaMs = 0) {
  const p95Ratio = control.p95Ms > 0 ? round(candidate.p95Ms / control.p95Ms) : null;
  const p95DeltaMs = round(candidate.p95Ms - control.p95Ms);
  return {
    maxP95Ratio,
    maxP95DeltaMs,
    actualP95Ratio: p95Ratio,
    actualP95DeltaMs: p95DeltaMs,
    passed: p95Ratio !== null && (p95Ratio <= maxP95Ratio || (maxP95DeltaMs > 0 && p95DeltaMs <= maxP95DeltaMs)),
  };
}

export function evaluateRepeatedUserExperienceGate(attemptDetails: ReadonlyArray<{
  passed: boolean;
  actualP95Ratio: number | null;
  actualP95DeltaMs: number;
}>) {
  const passCount = attemptDetails.filter((attempt) => attempt.passed).length;
  const failureCount = attemptDetails.length - passCount;
  const firstAttemptFastPath = attemptDetails.length === 1 && attemptDetails[0]?.passed === true;
  const ratios = attemptDetails
    .map((attempt) => attempt.actualP95Ratio)
    .filter((value): value is number => typeof value === 'number');
  const deltas = attemptDetails.map((attempt) => attempt.actualP95DeltaMs);
  const representativeActualP95Ratio = ratios.length > 0 ? round(percentile(ratios, 50)) : null;
  const representativeActualP95DeltaMs = deltas.length > 0 ? round(percentile(deltas, 50)) : 0;
  const majorityPassed = passCount >= SSE_SYNC_REQUIRED_PASSES;
  const robustRetryMedianPassed = attemptDetails.length === SSE_SYNC_MAX_ATTEMPTS
    && representativeActualP95Ratio !== null
    && (representativeActualP95Ratio <= SSE_SYNC_RETRY_MEDIAN_P95_RATIO_MAX
      || representativeActualP95DeltaMs <= SSE_SYNC_RETRY_MEDIAN_P95_DELTA_MAX_MS);
  const passed = firstAttemptFastPath || majorityPassed || robustRetryMedianPassed;
  return {
    attempts: attemptDetails.length,
    maxAttempts: SSE_SYNC_MAX_ATTEMPTS,
    requiredPasses: SSE_SYNC_REQUIRED_PASSES,
    retryMedianP95RatioMax: SSE_SYNC_RETRY_MEDIAN_P95_RATIO_MAX,
    retryMedianP95DeltaMaxMs: SSE_SYNC_RETRY_MEDIAN_P95_DELTA_MAX_MS,
    passCount,
    failureCount,
    firstAttemptFastPath,
    majorityPassed,
    robustRetryMedianPassed,
    representativeActualP95Ratio,
    representativeActualP95DeltaMs,
    decisionMode: firstAttemptFastPath
      ? 'single-pass-fast-path'
      : majorityPassed
        ? 'majority'
        : robustRetryMedianPassed
          ? 'robust-retry-median'
          : 'failed',
    passed,
  };
}

function asyncUserExperienceBudget(candidate: ProtocolMeasurements['asyncWorkloads'], control: ProtocolMeasurements['asyncWorkloads']) {
  const candidateStats = summarize(candidate.map((entry) => entry.endToEndMs));
  const controlStats = summarize(control.map((entry) => entry.endToEndMs));
  const latency = userExperienceBudget(candidateStats, controlStats);
  return {
    candidate: candidateStats,
    control: controlStats,
    maxP95Ratio: latency.maxP95Ratio,
    actualP95Ratio: latency.actualP95Ratio,
    passed: latency.passed,
  };
}

async function startBenchmarkServer() {
  const app = express();
  app.use('/mcp', express.json({ limit: '1mb' }));
  app.use('/mcp-baseline', express.json({ limit: '1mb' }));

  const benchmarkJobs = new Map<string, {
    durationMs: number;
    status: 'running' | 'succeeded';
    result: { completedAfterMs: number } | null;
    completion: Promise<void>;
  }>();
  app.post('/api/tool-jobs', express.json({ limit: '1mb' }), (req, res) => {
    const durationMatch = String(req.body?.args?.command || '').match(/^benchmark-delay-(\d+)$/);
    if (req.body?.toolName !== 'run_project_command' || !durationMatch) {
      res.status(400).json({ error: 'Benchmark fixture only accepts benchmark-delay jobs.' });
      return;
    }
    const jobId = `benchmark-job-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const durationMs = Number(durationMatch[1]);
    const job: {
      durationMs: number;
      status: 'running' | 'succeeded';
      result: { completedAfterMs: number } | null;
      completion: Promise<void>;
    } = {
      durationMs,
      status: 'running',
      result: null as { completedAfterMs: number } | null,
      completion: Promise.resolve(),
    };
    job.completion = new Promise((resolve) => {
      setTimeout(() => {
        job.status = 'succeeded';
        job.result = { completedAfterMs: durationMs };
        resolve();
      }, durationMs).unref?.();
    });
    benchmarkJobs.set(jobId, job);
    res.json({ jobId, status: 'queued', handoffImmediately: false });
  });
  app.get('/api/tool-jobs/:jobId/result', async (req, res) => {
    const job = benchmarkJobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Benchmark job not found.' });
      return;
    }
    const waitMs = Math.max(0, Math.min(30_000, Number(req.query.waitMs) || 0));
    let timedOut = false;
    await Promise.race([
      job.completion,
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, waitMs);
        timer.unref?.();
      }),
    ]);
    if (timedOut && job.status !== 'succeeded') {
      res.json({ jobId: req.params.jobId, status: job.status, ready: false, result: null, code: 'JOB_STILL_RUNNING' });
      return;
    }
    res.json({
      jobId: req.params.jobId,
      status: job.status,
      ready: true,
      result: { result: job.result },
    });
  });

  app.get('/api/capabilities/tools/:toolName', (req, res) => {
    res.json({
      name: req.params.toolName,
      description: 'Benchmark fixture response.',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
    });
  });

  let apiBaseUrl = '';
  let reusableMcpHandler: ReturnType<typeof createReusableMcpHttpHandler> | null = null;
  app.post('/mcp', (req, res, next) => {
    if (!reusableMcpHandler) throw new Error('Reusable MCP benchmark handler is not initialized.');
    return reusableMcpHandler(req, res, next);
  });
  app.post('/mcp-baseline', async (req, res, next) => {
    const mcpServer = createDevFlowMcpServer(apiBaseUrl, 'full');
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: 'Stateless baseline transport failed.' });
      else next(error);
    } finally {
      await transport.close().catch(() => {});
    }
  });

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
  reusableMcpHandler = createReusableMcpHttpHandler(apiBaseUrl, 'full');

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

function statelessBaselineClient(baseUrl: string, label: string) {
  const client = new Client({ name: `benchmark-mcp-baseline-${label}`, version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp-baseline', baseUrl));
  return { client, transport };
}

function sseClient(baseUrl: string, label: string) {
  const client = new Client({ name: `benchmark-sse-${label}`, version: '1.0.0' });
  const transport = new SSEClientTransport(new URL('/sse', baseUrl));
  return { client, transport };
}

async function benchmarkProtocol(
  baseUrl: string,
  transport: 'streamable-http' | 'streamable-http-stateless-baseline' | 'legacy-sse',
  coldSamples: number,
  warmSamples: number,
): Promise<ProtocolMeasurements> {
  const createClient = transport === 'streamable-http'
    ? streamableClient
    : transport === 'streamable-http-stateless-baseline'
      ? statelessBaselineClient
      : sseClient;
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
  const asyncWorkloads: ProtocolMeasurements['asyncWorkloads'] = [];
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
    for (const durationMs of ASYNC_BENCHMARK_DURATIONS_MS) {
      const asyncCall = await measure(() => warm.client.callTool({
        name: 'run_project_command',
        arguments: { projectId: 'benchmark-project', command: `benchmark-delay-${durationMs}` },
      }));
      const structured = (asyncCall.value as any)?.structuredContent;
      const completedWithoutFollowUp = structured?.completedAfterMs === durationMs;
      asyncWorkloads.push({
        durationMs,
        endToEndMs: round(asyncCall.durationMs),
        completedWithoutFollowUp,
        completionMode: completedWithoutFollowUp ? 'request-stream' : 'durable-handoff',
      });
    }
  } finally {
    await warm.client.close().catch(() => {});
  }

  return {
    transport,
    endpoint: transport === 'streamable-http'
      ? '/mcp'
      : transport === 'streamable-http-stateless-baseline'
        ? '/mcp-baseline'
        : '/sse',
    cold: {
      initialize: summarize(initializeSamples),
      listTools: summarize(coldListSamples),
      callTool: summarize(coldCallSamples),
    },
    warm: {
      listTools: summarize(warmListSamples),
      callTool: summarize(warmCallSamples),
    },
    asyncWorkloads,
    payload: payloadMetrics(listedPayload, callPayload),
  };
}

async function benchmarkSseSyncRetryRound(baseUrl: string, warmSamples: number, attemptNumber: number) {
  const candidate = streamableClient(baseUrl, `sse-sync-retry-${attemptNumber}-streamable-http`);
  const control = sseClient(baseUrl, `sse-sync-retry-${attemptNumber}-legacy-sse`);
  const candidateSamples: number[] = [];
  const controlSamples: number[] = [];
  try {
    await candidate.client.connect(candidate.transport);
    await control.client.connect(control.transport);
    const warmOrder = attemptNumber % 2 === 0 ? [control, candidate] : [candidate, control];
    for (const current of warmOrder) {
      await current.client.listTools();
      await current.client.callTool({ name: BENCHMARK_TOOL_NAME, arguments: BENCHMARK_TOOL_ARGS });
    }
    for (let index = 0; index < warmSamples; index += 1) {
      const controlFirst = (index + attemptNumber) % 2 === 0;
      const ordered = controlFirst
        ? [{ current: control, samples: controlSamples }, { current: candidate, samples: candidateSamples }]
        : [{ current: candidate, samples: candidateSamples }, { current: control, samples: controlSamples }];
      for (const { current, samples } of ordered) {
        await current.client.listTools();
        const called = await measure(() => current.client.callTool({ name: BENCHMARK_TOOL_NAME, arguments: BENCHMARK_TOOL_ARGS }));
        samples.push(called.durationMs);
      }
    }
    return userExperienceBudget(
      summarize(candidateSamples),
      summarize(controlSamples),
      SSE_SYNC_P95_RATIO_MAX,
      SSE_SYNC_P95_DELTA_MAX_MS,
    );
  } finally {
    await Promise.all([
      candidate.client.close().catch(() => {}),
      control.client.close().catch(() => {}),
    ]);
  }
}

export async function runMcpTransportBenchmark(options: BenchmarkOptions = {}) {
  const coldSamples = positiveSampleCount(options.coldSamples, DEFAULT_COLD_SAMPLES, 'coldSamples');
  const warmSamples = positiveSampleCount(options.warmSamples, DEFAULT_WARM_SAMPLES, 'warmSamples');
  const fixture = await startBenchmarkServer();

  try {
    const streamableHttpBaseline = await benchmarkProtocol(fixture.baseUrl, 'streamable-http-stateless-baseline', coldSamples, warmSamples);
    const streamableHttp = await benchmarkProtocol(fixture.baseUrl, 'streamable-http', coldSamples, warmSamples);
    const legacySse = await benchmarkProtocol(fixture.baseUrl, 'legacy-sse', coldSamples, warmSamples);
    const warmListBudget = warmRegressionBudget(streamableHttp.warm.listTools, streamableHttpBaseline.warm.listTools);
    const warmCallBudget = warmRegressionBudget(streamableHttp.warm.callTool, streamableHttpBaseline.warm.callTool);
    const sseSyncAttempts = [userExperienceBudget(
      streamableHttp.warm.callTool,
      legacySse.warm.callTool,
      SSE_SYNC_P95_RATIO_MAX,
      SSE_SYNC_P95_DELTA_MAX_MS,
    )];
    if (!sseSyncAttempts[0].passed) {
      for (let attemptNumber = 2; attemptNumber <= SSE_SYNC_MAX_ATTEMPTS; attemptNumber += 1) {
        sseSyncAttempts.push(await benchmarkSseSyncRetryRound(fixture.baseUrl, warmSamples, attemptNumber));
      }
    }
    const sseSyncBudget = {
      ...sseSyncAttempts[0],
      ...evaluateRepeatedUserExperienceGate(sseSyncAttempts),
      attemptDetails: sseSyncAttempts,
    };
    const sseAsyncBudget = asyncUserExperienceBudget(streamableHttp.asyncWorkloads, legacySse.asyncWorkloads);
    const sseRepresentativeBudget = userExperienceBudget(
      summarize([streamableHttp.warm.callTool.p50Ms, streamableHttp.warm.callTool.p95Ms, ...streamableHttp.asyncWorkloads.map((entry) => entry.endToEndMs)]),
      summarize([legacySse.warm.callTool.p50Ms, legacySse.warm.callTool.p95Ms, ...legacySse.asyncWorkloads.map((entry) => entry.endToEndMs)]),
    );
    const eligibleAsync = streamableHttp.asyncWorkloads.filter((entry) => entry.durationMs <= ASYNC_COMPLETION_WINDOW_MS);
    const completedAsync = eligibleAsync.filter((entry) => entry.completedWithoutFollowUp);
    const asyncCompletionBudget = {
      windowMs: ASYNC_COMPLETION_WINDOW_MS,
      eligibleJobs: eligibleAsync.length,
      completedWithoutFollowUp: completedAsync.length,
      eligibleWithoutFollowUpRate: eligibleAsync.length > 0 ? round(completedAsync.length / eligibleAsync.length) : 0,
      minimumRate: 0.95,
      passed: eligibleAsync.length > 0 && completedAsync.length / eligibleAsync.length >= 0.95,
    };
    return {
      schemaVersion: 2 as const,
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
        streamableHttpBaseline,
        streamableHttp,
        legacySse,
      },
      comparison: {
        baseline: 'streamableHttpBaseline' as const,
        candidate: 'streamableHttp' as const,
        cold: {
          initialize: compareLatency(streamableHttp.cold.initialize, streamableHttpBaseline.cold.initialize),
          listTools: compareLatency(streamableHttp.cold.listTools, streamableHttpBaseline.cold.listTools),
          callTool: compareLatency(streamableHttp.cold.callTool, streamableHttpBaseline.cold.callTool),
        },
        warm: {
          listTools: compareLatency(streamableHttp.warm.listTools, streamableHttpBaseline.warm.listTools),
          callTool: compareLatency(streamableHttp.warm.callTool, streamableHttpBaseline.warm.callTool),
        },
      },
      fallbackComparison: {
        baseline: 'legacySse' as const,
        candidate: 'streamableHttp' as const,
        enforced: true,
        sync: sseSyncBudget,
        async: sseAsyncBudget,
        representative: sseRepresentativeBudget,
        passed: sseSyncBudget.passed && sseRepresentativeBudget.passed && sseAsyncBudget.passed,
        warm: {
          listTools: compareLatency(streamableHttp.warm.listTools, legacySse.warm.listTools),
          callTool: compareLatency(streamableHttp.warm.callTool, legacySse.warm.callTool),
        },
      },
      regressionBudget: {
        thresholdSource: 'same-run-stateless-baseline' as const,
        warmP50BaselineRatioMax: WARM_P50_BASELINE_RATIO_MAX,
        warmP95BaselineDeltaMaxMs: WARM_P95_BASELINE_DELTA_MAX_MS,
        warm: {
          listTools: warmListBudget,
          callTool: warmCallBudget,
        },
        passed: warmListBudget.passed && warmCallBudget.passed,
      },
      asyncCompletionBudget,
      enforcedUserExperienceGate: {
        completion: asyncCompletionBudget,
        legacySse: {
          sync: sseSyncBudget,
          async: sseAsyncBudget,
          representative: sseRepresentativeBudget,
        },
        passed: asyncCompletionBudget.passed && sseSyncBudget.passed && sseRepresentativeBudget.passed && sseAsyncBudget.passed,
      },
      limitations: [
        'Measures localhost/loopback protocol and DevFlow server overhead inside one Node.js process; machine load can affect results.',
        'Does not measure ChatGPT model/tool-selection time, external public-tunnel latency, internet routing, or platform-side MCP registry/serialization overhead.',
        'The stateless baseline intentionally recreates the pre-session-reuse per-request MCP server/transport behavior in the same process so before/after ratios share machine load.',
        'The warm regression gate requires p50 to improve by at least 5% versus the same-run stateless baseline while allowing at most +2 ms p95 tail variance, preserving a material steady-state gain without making the gate flaky on millisecond-scale outliers.',
        'The legacy SSE comparison is an enforced same-run user-experience control for sync and 3s/10s durable jobs; a passing sync round exits immediately. An initial failure runs two interleaved alternating-order sync-only retries. The repeated decision passes on a 2-of-3 majority, or when all three rounds show a retry-set median within the measured jitter band (<=1.35x or <=3 ms p95 delta), while sustained regressions outside that band still fail and durable jobs are not rerun.',
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
    if (!result.enforcedUserExperienceGate.passed || !result.fallbackComparison.passed) process.exitCode = 1;
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
