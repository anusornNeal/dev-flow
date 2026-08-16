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
  getZrokRecoveryDecision,
  normalizeZrokPublicUrl,
  parseZrokBootstrapResult,
  resolveStartAllOptions,
  shouldRecoverZrokTunnel,
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

assert.equal(normalizeZrokPublicUrl({ publicUrl: 'devflow-mixed.shares.zrok.io/mcp' }), 'https://devflow-mixed.shares.zrok.io');
assert.equal(normalizeZrokPublicUrl({ reservedName: 'devflow-mixed' }), 'https://devflow-mixed.shares.zrok.io');
assert.equal(normalizeZrokPublicUrl({ reservedName: 'devflow-mixed.shares.zrok.io' }), 'https://devflow-mixed.shares.zrok.io');
assert.equal(normalizeZrokPublicUrl({}), '');

assert.deepEqual(resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_ZROK_RESERVED_NAME: 'devflow-mixed',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
}), {
  port: 3456,
  zrokPublicUrl: 'https://devflow-mixed.shares.zrok.io',
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

const bootstrapInvocation = buildZrokBootstrapInvocation('C:\\repo');
assert.match(bootstrapInvocation.scriptPath.replace(/\\/g, '/'), /scripts\/zrok-bootstrap\.ps1$/);
assert.ok(bootstrapInvocation.args.includes('-File'));
assert.equal(bootstrapInvocation.args.at(-1), bootstrapInvocation.scriptPath);

assert.deepEqual(parseZrokBootstrapResult(JSON.stringify({
  status: 'ready',
  reservedName: 'devflow-mixed',
  message: 'ready',
})), {
  ready: true,
  publicUrl: 'https://devflow-mixed.shares.zrok.io',
  message: 'ready',
});
assert.deepEqual(parseZrokBootstrapResult([
  'progress line',
  JSON.stringify({ ready: true, publicUrl: 'https://devflow-mixed.shares.zrok.io/mcp' }),
].join('\n')), {
  ready: true,
  publicUrl: 'https://devflow-mixed.shares.zrok.io',
  message: 'zrok bootstrap is ready.',
});
assert.equal(parseZrokBootstrapResult('not-json', 'https://fallback.shares.zrok.io').ready, false);
assert.equal(parseZrokBootstrapResult('not-json', 'https://fallback.shares.zrok.io').publicUrl, 'https://fallback.shares.zrok.io');
const notReady = parseZrokBootstrapResult(JSON.stringify({ ready: false, status: 'degraded', message: 'service stopped' }));
assert.equal(notReady.ready, false);
assert.equal(notReady.message, 'service stopped');

assert.equal(apiCapabilitiesUrl('https://devflow-mixed.shares.zrok.io'), 'https://devflow-mixed.shares.zrok.io/api/capabilities');
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
  shuttingDown: false,
  nowMs: 40000,
}), 'reconcile-zrok');
assert.equal(shouldRecoverZrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: false,
  shuttingDown: false,
  nowMs: 40000,
}), false);
assert.equal(getZrokRecoveryDecision({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  shuttingDown: false,
  recoveryCooldownUntilMs: 45000,
  nowMs: 40000,
}), 'suppressed-recovery-cooldown');
assert.equal(shouldRecoverZrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  shuttingDown: true,
  nowMs: 40000,
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
const retiredTunnelName = ['n', 'grok'].join('');
for (const source of [startAllSource, supervisorSource]) {
  assert.equal(source.toLowerCase().includes(retiredTunnelName), false);
  assert.doesNotMatch(source, /127\.0\.0\.1:4040|ERR_[A-Z]+_334/);
}

console.log('[verify-start-all] all assertions passed');
