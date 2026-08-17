import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts.dev, 'tsx scripts/start-all.ts --server-only');
assert.equal(packageJson.scripts['dev:server'], 'tsx server.ts');
assert.equal(packageJson.scripts['start:all'], 'tsx scripts/start-all.ts');

const {
  apiCapabilitiesUrl,
  buildNpmInvocation,
  buildStartAllPlan,
  buildZrokBootstrapInvocation,
  classifyPublicProbeFailure,
  apiZrokStatusUrl,
  getZrokRecoveryDecision,
  normalizeZrokPublicUrl,
  shouldRecoverZrokSupervisorProcess,
  parseZrokBootstrapResult,
  probeZrokPublicRoute,
  probeZrokRuntimeStatus,
  selectZrokPublicProbeUrl,
  resolveStartAllOptions,
  shouldRestartServerProcess,
} = await import('./start-all');
const {
  advanceDevFlowTunnelHealth,
  resetDevFlowTunnelHealthForGeneration,
} = await import('../src/lib/devFlowSupervisor');

assert.deepEqual(buildNpmInvocation(['run', 'dev:server'], { npm_execpath: 'C:\\node\\npm-cli.js' }), {
  command: process.execPath,
  args: ['C:\\node\\npm-cli.js', 'run', 'dev:server'],
});

assert.equal(normalizeZrokPublicUrl({ publicUrl: 'devflow-mixed.shares.zrok.io/mcp' }), 'https://devflow-mixed.shares.zrok.io/mcp');
assert.equal(
  normalizeZrokPublicUrl({ publicUrl: 'https://custom.example/app///?ignored=query#ignored' }),
  'https://custom.example/app',
);
assert.equal(normalizeZrokPublicUrl({ publicUrl: 'https://user:secret@custom.example/app' }), '');
assert.equal(normalizeZrokPublicUrl({ reservedName: 'devflow-mixed' }), '');
assert.equal(normalizeZrokPublicUrl({ reservedName: 'devflow-mixed.shares.zrok.io' }), '');
assert.equal(normalizeZrokPublicUrl({}), '');

assert.deepEqual(resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_ZROK_RESERVED_NAME: 'devflow-mixed',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
}), {
  port: 3456,
  zrokPublicUrl: '',
  zrokReservedName: 'devflow-mixed',
  openBrowser: true,
  openBrowserDelayMs: 250,
  zrokProbeIntervalMs: 15000,
  zrokProbeTimeoutMs: 5000,
  zrokProbeStartupGraceMs: 30000,
  zrokProbeFailureThreshold: 3,
  zrokRecoveryCooldownMs: 15000,
});

const capped = resolveStartAllOptions({ DEVFLOW_ZROK_PROBE_STARTUP_GRACE_MS: '999999' });
assert.equal(capped.zrokProbeStartupGraceMs, 120000);

const options = resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_ZROK_PUBLIC_URL: 'https://devflow-mixed.shares.zrok.io',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
});
const plan = buildStartAllPlan(options, 'all-token', 'all');
assert.equal(plan.mode, 'all');
assert.deepEqual(plan.processes.map((entry) => entry.label), ['server']);
assert.deepEqual(plan.processes[0].args.slice(-2), ['run', 'dev:server']);
assert.equal(plan.appUrl, 'http://localhost:3456');
assert.equal(plan.openBrowser, true);
assert.equal(plan.openBrowserDelayMs, 250);
assert.equal(plan.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR, 'start-all');
assert.equal(plan.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'all-token');

const serverOnly = buildStartAllPlan(options, 'server-token', 'server-only');
assert.deepEqual(serverOnly.processes.map((entry) => entry.label), ['server']);
assert.equal(serverOnly.openBrowser, false);
assert.equal(serverOnly.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'server-token');

const bootstrapInvocation = buildZrokBootstrapInvocation('C:\\repo', 'account-specific-name');
assert.match(bootstrapInvocation.scriptPath.replace(/\\/g, '/'), /scripts\/zrok-bootstrap\.ps1$/);
assert.ok(bootstrapInvocation.args.includes('-File'));
assert.deepEqual(bootstrapInvocation.args.slice(-2), ['-ReservedName', 'account-specific-name']);
const bootstrapInvocationWithoutName = buildZrokBootstrapInvocation('C:\\repo');
assert.equal(bootstrapInvocationWithoutName.args.includes('-ReservedName'), false);

assert.deepEqual(parseZrokBootstrapResult(JSON.stringify({
  status: 'ready',
  reservedName: 'devflow-mixed',
  message: 'ready',
})), {
  ready: true,
  publicUrl: '',
  message: 'ready',
});
assert.deepEqual(parseZrokBootstrapResult(JSON.stringify({
  ok: true,
  code: 'ready',
  reservedName: 'account-specific-name',
  message: 'zrok bootstrap is ready.',
})), {
  ready: true,
  publicUrl: '',
  message: 'zrok bootstrap is ready.',
});
assert.deepEqual(parseZrokBootstrapResult([
  'progress line',
  JSON.stringify({ ready: true, publicUrl: 'https://devflow-mixed.shares.zrok.io/mcp' }),
].join('\n')), {
  ready: true,
  publicUrl: 'https://devflow-mixed.shares.zrok.io/mcp',
  message: 'zrok bootstrap is ready.',
});
assert.equal(parseZrokBootstrapResult('not-json', 'https://fallback.shares.zrok.io').ready, false);
assert.equal(parseZrokBootstrapResult('not-json', 'https://fallback.shares.zrok.io').publicUrl, 'https://fallback.shares.zrok.io');
const notReady = parseZrokBootstrapResult(JSON.stringify({ ready: false, status: 'degraded', message: 'service stopped' }));
assert.equal(notReady.ready, false);
assert.equal(notReady.message, 'service stopped');

assert.equal(apiCapabilitiesUrl('https://devflow-mixed.shares.zrok.io'), 'https://devflow-mixed.shares.zrok.io/api/capabilities');
assert.equal(apiCapabilitiesUrl('https://custom.example/app'), 'https://custom.example/app/api/capabilities');
assert.equal(apiZrokStatusUrl('https://devflow-mixed.shares.zrok.io'), 'https://devflow-mixed.shares.zrok.io/api/zrok/status');
const dynamicRuntime = await probeZrokRuntimeStatus('http://localhost:3456', 500, async () => new Response(JSON.stringify({
  status: 'online',
  baseUrl: 'https://dynamic-account.example/app',
  share: { state: 'active' },
}), { status: 200, headers: { 'content-type': 'application/json' } }));
assert.deepEqual(dynamicRuntime, {
  status: 'online',
  shareState: 'active',
  baseUrl: 'https://dynamic-account.example/app',
});
const oversizedByHeader = await probeZrokRuntimeStatus('http://localhost:3456', 500, async () => new Response(JSON.stringify({
  status: 'online',
  baseUrl: 'https://oversized.example',
  share: { state: 'active' },
}), {
  status: 200,
  headers: { 'content-length': String(256 * 1024 + 1) },
}));
assert.equal(oversizedByHeader, undefined, 'declared oversized local zrok status is rejected before parsing');
let oversizedStreamCancelled = false;
const oversizedChunked = await probeZrokRuntimeStatus('http://localhost:3456', 500, async () => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(' '.repeat(256 * 1024 + 1)));
    controller.enqueue(new TextEncoder().encode(JSON.stringify({
      status: 'online',
      baseUrl: 'https://oversized.example',
      share: { state: 'active' },
    })));
    controller.close();
  },
  cancel() {
    oversizedStreamCancelled = true;
  },
}), { status: 200 }));
assert.equal(oversizedChunked, undefined, 'chunked oversized local zrok status is rejected');
assert.equal(oversizedStreamCancelled, true, 'chunked oversized local zrok status stream is cancelled');
const probedUrls: string[] = [];
const dynamicRouteProbe = await probeZrokPublicRoute(
  'http://localhost:3456',
  '',
  500,
  async (input) => {
    const url = String(input);
    probedUrls.push(url);
    if (url === 'http://localhost:3456/api/zrok/status') {
      return new Response(JSON.stringify({
        status: 'online',
        baseUrl: 'https://dynamic-account.example/app',
        share: { state: 'active' },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  },
);
assert.equal(dynamicRouteProbe.publicUrl, 'https://dynamic-account.example/app');
assert.equal(dynamicRouteProbe.publicProbe.ok, true);
assert.deepEqual(probedUrls, [
  'http://localhost:3456/api/zrok/status',
  'https://dynamic-account.example/app/api/capabilities',
]);
assert.equal(
  selectZrokPublicProbeUrl('https://configured.example', dynamicRuntime),
  'https://dynamic-account.example/app',
  'live local zrok status replaces the public probe target without a supervisor restart',
);
assert.equal(
  selectZrokPublicProbeUrl('https://configured.example', { status: 'degraded', shareState: 'unknown' }),
  'https://configured.example',
  'an absent live base URL preserves the current public probe target',
);
assert.equal(
  selectZrokPublicProbeUrl('https://configured.example', { baseUrl: 'not a valid URL' }),
  'https://configured.example',
  'an invalid live base URL preserves the current public probe target',
);
assert.equal(classifyPublicProbeFailure({ statusCode: 503 }), 'http-5xx');
assert.equal(classifyPublicProbeFailure({ error: Object.assign(new Error('request timed out'), { name: 'AbortError' }) }), 'timeout');
assert.equal(classifyPublicProbeFailure({ error: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) }), 'dns');

const acceptedRestart = {
  ticket: 'restart-test',
  status: 'accepted' as const,
  supervisor: 'start-all',
  supervisorToken: 'supervisor-token',
};
assert.equal(shouldRestartServerProcess({
  label: 'server',
  exitCode: 75,
  supervisorToken: 'supervisor-token',
  shuttingDown: false,
  restartState: acceptedRestart,
}), true);
assert.equal(shouldRestartServerProcess({
  label: 'server',
  exitCode: 75,
  supervisorToken: 'supervisor-token',
  shuttingDown: true,
  restartState: acceptedRestart,
}), false);

assert.equal(getZrokRecoveryDecision({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  zrokStatus: 'standby',
  zrokShareState: 'remote-active',
  shuttingDown: false,
  nowMs: 40000,
}), 'suppressed-standby');
assert.equal(getZrokRecoveryDecision({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  zrokStatus: 'online',
  zrokShareState: 'active',
  shuttingDown: false,
  nowMs: 40000,
}), 'suppressed-periodic-recovery');
assert.equal(getZrokRecoveryDecision({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  shuttingDown: false,
  recoveryCooldownUntilMs: 45000,
  nowMs: 40000,
}), 'suppressed-recovery-cooldown');
assert.equal(shouldRecoverZrokSupervisorProcess({
  publicRouteHealthy: true,
  processStatus: 'failed',
  zrokStatus: 'online',
  zrokShareState: 'active',
}), true);
assert.equal(shouldRecoverZrokSupervisorProcess({
  publicRouteHealthy: false,
  processStatus: 'failed',
  zrokStatus: 'online',
  zrokShareState: 'active',
}), false);
assert.equal(shouldRecoverZrokSupervisorProcess({
  publicRouteHealthy: true,
  processStatus: 'failed',
  zrokStatus: 'standby',
  zrokShareState: 'remote-active',
}), false);
assert.equal(shouldRecoverZrokSupervisorProcess({
  publicRouteHealthy: true,
  processStatus: 'running',
  zrokStatus: 'online',
  zrokShareState: 'active',
}), false);
let health = resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
  startupGraceMs: 5000,
  now: '2026-08-16T00:00:00.000Z',
});
health = advanceDevFlowTunnelHealth(health, { ok: false, statusCode: 502 }, {
  failureThreshold: 3,
  generation: 'A',
  now: '2026-08-16T00:00:01.000Z',
});
assert.equal(health.status, 'unknown');
assert.equal(health.consecutiveProbeFailures, 0);

for (const now of ['2026-08-16T00:00:06.000Z', '2026-08-16T00:00:07.000Z', '2026-08-16T00:00:08.000Z']) {
  health = advanceDevFlowTunnelHealth(health, { ok: false, statusCode: 502 }, {
    failureThreshold: 3,
    generation: 'A',
    now,
  });
}
assert.equal(health.status, 'down');
assert.equal(health.consecutiveProbeFailures, 3);

const generationB = resetDevFlowTunnelHealthForGeneration(health, 'B', {
  startupGraceMs: 0,
  now: '2026-08-16T00:00:09.000Z',
});
const stale = advanceDevFlowTunnelHealth(generationB, { ok: true, statusCode: 200 }, {
  failureThreshold: 3,
  generation: 'A',
  now: '2026-08-16T00:00:10.000Z',
});
assert.deepEqual(stale, generationB);

const firstHealthy = advanceDevFlowTunnelHealth(generationB, { ok: true, statusCode: 200 }, {
  failureThreshold: 3,
  generation: 'B',
  now: '2026-08-16T00:00:11.000Z',
});
assert.equal(firstHealthy.status, 'healthy');
assert.equal(firstHealthy.lifecyclePhase, 'steady-state');

const startAllSource = fs.readFileSync(new URL('./start-all.ts', import.meta.url), 'utf8');
const supervisorSource = fs.readFileSync(new URL('../src/lib/devFlowSupervisor.ts', import.meta.url), 'utf8');
assert.doesNotMatch(startAllSource, /scheduleZrokReconcile|reconcileZrok/);
assert.match(startAllSource, /bootstrapZrokAtStartup\(\)/);
const failedBootstrapSection = startAllSource.slice(
  startAllSource.indexOf('Startup zrok bootstrap failed'),
  startAllSource.indexOf('async function runTunnelProbe'),
);
assert.equal(failedBootstrapSection.includes('scheduleTunnelProbe(250)'), true);
assert.equal(failedBootstrapSection.includes('runZrokBootstrap('), false);
const retiredTunnelName = ['n', 'grok'].join('');
for (const source of [startAllSource, supervisorSource]) {
  assert.equal(source.toLowerCase().includes(retiredTunnelName), false);
  assert.doesNotMatch(source, /127\.0\.0\.1:4040|ERR_[A-Z]+_334/);
}

console.log('[verify-start-all] all assertions passed');
