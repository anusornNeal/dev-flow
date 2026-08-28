import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts.dev, 'tsx scripts/start-all.ts --server-only');
assert.equal(packageJson.scripts['dev:server'], 'tsx server.ts');
assert.equal(packageJson.scripts['start:all'], 'tsx scripts/start-all.ts');
assert.equal(packageJson.scripts['tunnel:start'], 'tsx scripts/openai-tunnel.ts start');
assert.equal(packageJson.scripts['tunnel:status'], 'tsx scripts/openai-tunnel.ts status');
assert.equal(packageJson.scripts['tunnel:stop'], 'tsx scripts/openai-tunnel.ts stop');

const {
  buildNpmInvocation,
  buildStartAllPlan,
  resolveStartAllOptions,
  shouldRestartServerProcess,
  waitForLocalApi,
} = await import('./start-all');
const {
  buildOpenAiTunnelInvocation,
  getOpenAiTunnelStatus,
  resolveOpenAiTunnelOptions,
  startOpenAiTunnel,
  stopOpenAiTunnel,
} = await import('./openai-tunnel');

assert.deepEqual(buildNpmInvocation(['run', 'dev:server'], { npm_execpath: 'C:\\node\\npm-cli.js' }), {
  command: process.execPath,
  args: ['C:\\node\\npm-cli.js', 'run', 'dev:server'],
});

assert.deepEqual(resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_OPEN_BROWSER: 'false',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
  DEVFLOW_TUNNEL_STARTUP_WAIT_MS: '1200',
}), {
  port: 3456,
  openBrowser: false,
  openBrowserDelayMs: 250,
  tunnelStartupWaitMs: 1200,
});
assert.equal(resolveStartAllOptions({ DEVFLOW_TUNNEL_STARTUP_WAIT_MS: '999999' }).tunnelStartupWaitMs, 120000);

const plan = buildStartAllPlan(resolveStartAllOptions({ DEVFLOW_PORT: '3456' }), 'all-token', 'all');
assert.equal(plan.mode, 'all');
assert.equal(plan.appUrl, 'http://localhost:3456');
assert.equal(plan.openBrowser, true);
assert.deepEqual(plan.processes.map((entry) => entry.label), ['server']);
assert.deepEqual(plan.processes[0].args.slice(-2), ['run', 'dev:server']);
assert.equal(plan.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR, 'start-all');
assert.equal(plan.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'all-token');

const localPlan = buildStartAllPlan(resolveStartAllOptions({ DEVFLOW_PORT: '3456' }), 'local-token', 'server-only');
assert.equal(localPlan.openBrowser, false);
assert.equal(localPlan.processes[0].env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'local-token');

const acceptedRestart = {
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-openai-tunnel-options-'));
const tunnelEnv = {
  DEVFLOW_PORT: '3456',
  DEVFLOW_OPENAI_TUNNEL_ID: 'tunnel_abc123',
  CONTROL_PLANE_API_KEY: 'runtime-secret-value',
  DEVFLOW_TUNNEL_ALIAS: 'devflow-test',
  DEVFLOW_TUNNEL_CLIENT_BIN: 'C:\\tools\\tunnel-client.exe',
} as NodeJS.ProcessEnv;
const tunnelOptions = resolveOpenAiTunnelOptions(tunnelEnv, tempRoot);
assert.equal(tunnelOptions.alias, 'devflow-test');
assert.equal(tunnelOptions.tunnelId, 'tunnel_abc123');
assert.equal(tunnelOptions.mcpServerUrl, 'http://127.0.0.1:3456/mcp');
assert.equal(tunnelOptions.runtimeKeyEnvName, 'CONTROL_PLANE_API_KEY');
assert.equal(tunnelOptions.stateDir, path.join(tempRoot, '.devflow', 'tunnel-client'));

const persistedTunnelConfig = {
  tunnelId: 'tunnel_saved123',
  runtimeApiKey: 'saved-runtime-secret',
};
const persistedTunnelOptions = resolveOpenAiTunnelOptions(
  { DEVFLOW_PORT: '3456' },
  tempRoot,
  persistedTunnelConfig,
);
assert.equal(persistedTunnelOptions.tunnelId, 'tunnel_saved123');
assert.equal(persistedTunnelOptions.runtimeKeyEnvName, 'CONTROL_PLANE_API_KEY');
const persistedInvocation = buildOpenAiTunnelInvocation('start', persistedTunnelOptions, { DEVFLOW_PORT: '3456' });
assert.equal(persistedInvocation.env.CONTROL_PLANE_API_KEY, 'saved-runtime-secret');
assert.equal(persistedInvocation.args.includes('saved-runtime-secret'), false, 'persisted runtime key must stay out of command arguments');

const settingsPreferredTunnelOptions = resolveOpenAiTunnelOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_OPENAI_TUNNEL_ID: 'tunnel_env456',
  CONTROL_PLANE_API_KEY: 'env-runtime-secret',
}, tempRoot, persistedTunnelConfig);
assert.equal(settingsPreferredTunnelOptions.tunnelId, 'tunnel_saved123', 'saved Settings tunnel id must override stale environment config');
const settingsPreferredInvocation = buildOpenAiTunnelInvocation('start', settingsPreferredTunnelOptions, {
  DEVFLOW_PORT: '3456',
  CONTROL_PLANE_API_KEY: 'env-runtime-secret',
});
assert.equal(settingsPreferredInvocation.env.CONTROL_PLANE_API_KEY, 'saved-runtime-secret', 'saved Settings runtime key must override stale environment config');

const startInvocation = buildOpenAiTunnelInvocation('start', tunnelOptions, tunnelEnv);
assert.equal(startInvocation.command, 'C:\\tools\\tunnel-client.exe');
assert.deepEqual(startInvocation.args.slice(0, 2), ['runtimes', 'connect']);
assert.ok(startInvocation.args.includes('--tunnel-id'));
assert.ok(startInvocation.args.includes('tunnel_abc123'));
assert.ok(startInvocation.args.includes('--runtime-api-key'));
assert.ok(startInvocation.args.includes('env:CONTROL_PLANE_API_KEY'));
assert.ok(startInvocation.args.includes('--mcp-server-url'));
assert.ok(startInvocation.args.includes('http://127.0.0.1:3456/mcp'));
assert.equal(startInvocation.args.includes('runtime-secret-value'), false, 'literal runtime key must not appear in tunnel-client arguments');
assert.equal(startInvocation.env.TUNNEL_CLIENT_STATE_DIR, tunnelOptions.stateDir);
assert.deepEqual(buildOpenAiTunnelInvocation('status', tunnelOptions, tunnelEnv).args, ['runtimes', 'status', 'devflow-test', '--json']);
assert.deepEqual(buildOpenAiTunnelInvocation('stop', tunnelOptions, tunnelEnv).args, ['runtimes', 'stop', 'devflow-test', '--json']);

const missingConfig = startOpenAiTunnel(
  resolveOpenAiTunnelOptions({ DEVFLOW_PORT: '3456' }, tempRoot),
  {},
  () => { throw new Error('runner must not be called for invalid configuration'); },
);
assert.equal(missingConfig.ok, false);
assert.equal(missingConfig.code, 'TUNNEL_CONFIG_INVALID');

function commandResult(input: {
  ok?: boolean;
  exitCode?: number;
  payload?: Record<string, unknown> | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}) {
  return {
    ok: input.ok ?? true,
    exitCode: input.exitCode ?? (input.ok === false ? 1 : 0),
    stdout: input.stdout ?? (input.payload ? JSON.stringify(input.payload) : ''),
    stderr: input.stderr ?? '',
    payload: input.payload ?? null,
    ...(input.error ? { error: input.error } : {}),
  };
}

const connectActions: string[] = [];
const connectResponses = [
  commandResult({ ok: false, stderr: 'unknown alias devflow-test' }),
  commandResult({ payload: { connected: true } }),
  commandResult({ payload: { process_running: true, healthy: true, ready: true } }),
];
const connected = startOpenAiTunnel(tunnelOptions, tunnelEnv, (invocation) => {
  connectActions.push(invocation.args[1]);
  const next = connectResponses.shift();
  assert.ok(next, 'unexpected extra tunnel-client call during connect');
  return next;
});
assert.equal(connected.ok, true);
assert.equal(connected.running, true);
assert.equal(connected.healthy, true);
assert.equal(connected.ready, true);
assert.equal(connected.reused, false);
assert.deepEqual(connectActions, ['status', 'connect', 'status']);

let reuseCalls = 0;
const reused = startOpenAiTunnel(tunnelOptions, tunnelEnv, () => {
  reuseCalls += 1;
  return commandResult({ payload: { process_running: true, healthy: true, ready: true } });
});
assert.equal(reused.ok, true);
assert.equal(reused.reused, true);
assert.equal(reuseCalls, 1, 'already-running runtime should not reconnect');

const missingStatus = getOpenAiTunnelStatus(tunnelOptions, tunnelEnv, () => commandResult({
  ok: false,
  stderr: 'runtime not found',
}));
assert.equal(missingStatus.ok, true);
assert.equal(missingStatus.running, false);

const stopActions: string[] = [];
const stopResponses = [
  commandResult({ payload: { process_running: true, healthy: true, ready: true } }),
  commandResult({ payload: { stopped: true } }),
  commandResult({ payload: { process_running: false, healthy: false, ready: false } }),
];
const stopped = stopOpenAiTunnel(tunnelOptions, tunnelEnv, (invocation) => {
  stopActions.push(invocation.args[1]);
  const next = stopResponses.shift();
  assert.ok(next, 'unexpected extra tunnel-client call during stop');
  return next;
});
assert.equal(stopped.ok, true);
assert.equal(stopped.running, false);
assert.deepEqual(stopActions, ['status', 'stop', 'status']);

let alreadyStoppedCalls = 0;
const alreadyStopped = stopOpenAiTunnel(tunnelOptions, tunnelEnv, () => {
  alreadyStoppedCalls += 1;
  return commandResult({ payload: { process_running: false } });
});
assert.equal(alreadyStopped.ok, true);
assert.equal(alreadyStopped.running, false);
assert.equal(alreadyStoppedCalls, 1, 'already-stopped runtime should not issue a stop command');

const apiReady = await waitForLocalApi('http://localhost:3456', 500, async () => new Response('{}', { status: 200 }));
assert.equal(apiReady.ok, true);

const activeSources = [
  '../scripts/start-all.ts',
  '../scripts/openai-tunnel.ts',
  '../src/lib/devFlowSupervisor.ts',
  '../src/server/routes/registerApiRoutes.ts',
  '../src/server/services/mcpToolMonitor.ts',
  '../src/components/Header.tsx',
  '../scripts/tray-server.ps1',
  '../.env.example',
  '../docs/runtime-supervisor.md',
  '../docs/architecture/cross-platform.md',
].map((relative) => fs.readFileSync(new URL(relative, import.meta.url), 'utf8'));
for (const source of activeSources) {
  assert.doesNotMatch(source, /zrok/i, 'active runtime/config documentation must not retain retired zrok references');
}

fs.rmSync(tempRoot, { recursive: true, force: true });
console.log('[verify-start-all] all assertions passed');
