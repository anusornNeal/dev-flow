import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts.dev, 'tsx scripts/start-all.ts --server-only');
assert.equal(packageJson.scripts['dev:server'], 'tsx server.ts');
assert.equal(packageJson.scripts['start:all'], 'tsx scripts/start-all.ts');

const trayScript = fs.readFileSync(new URL('./tray-server.ps1', import.meta.url), 'utf8');
const windowsLauncher = fs.readFileSync(new URL('../Start DevFlow.bat', import.meta.url), 'utf8');
assert.doesNotMatch(trayScript, /taskkill|Stop-Process|netstat\s+-ano/i);
assert.doesNotMatch(trayScript, /Start-Process[^\n]+ngrok(?:\.exe)?/i);
assert.doesNotMatch(trayScript, /\$timer\.add_Tick/);
assert.match(trayScript, /\/api\/restart/i);
assert.match(trayScript, /runtime-owner[\\/]owner\.json/i);
assert.match(trayScript, /System\.Threading\.Mutex/i);
assert.match(windowsLauncher, /run-server\.vbs/i);
assert.doesNotMatch(windowsLauncher, /npm\s+run\s+start:all/i);

const {
  buildNgrokArgs,
  buildNpmInvocation,
  buildStartAllPlan,
  computeManagedProcessRestartDelayMs,
  resolveStartAllOptions,
  shouldRestartServerProcess,
  shouldRestartManagedProcess,
  classifyNgrokDiagnosticLine,
  sanitizeNgrokDiagnosticLine,
  shouldRecoverNgrokTunnel,
  appendNgrokDiagnosticRecord,
} = await import('./start-all');
const {
  advanceDevFlowTunnelHealth,
  resetDevFlowTunnelHealthForGeneration,
} = await import('../src/lib/devFlowSupervisor');

assert.deepEqual(buildNgrokArgs({ port: 3000, domain: 'example.ngrok-free.dev' }), [
  'http',
  '--domain=example.ngrok-free.dev',
  '3000',
]);

assert.deepEqual(buildNgrokArgs({ port: 3000, domain: '' }), ['http', '3000']);
assert.deepEqual(buildNpmInvocation(['run', 'dev:server'], { npm_execpath: 'C:\\node\\npm-cli.js' }), {
  command: process.execPath,
  args: ['C:\\node\\npm-cli.js', 'run', 'dev:server'],
});

assert.deepEqual(resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_NGROK_DOMAIN: 'team-devflow.ngrok-free.dev',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
}), {
  port: 3456,
  ngrokDomain: 'team-devflow.ngrok-free.dev',
  openBrowser: true,
  openBrowserDelayMs: 250,
  ngrokRestartBaseMs: 1000,
  ngrokRestartMaxMs: 30000,
  ngrokStableResetMs: 60000,
  ngrokProbeIntervalMs: 15000,
  ngrokProbeTimeoutMs: 5000,
  ngrokProbeStartupGraceMs: 5000,
  ngrokProbeFailureThreshold: 3,
  ngrokCollisionBackoffMs: 30000,
  ngrokLogMaxBytes: 131072,
});

const options = {
  port: 3456,
  ngrokDomain: 'team-devflow.ngrok-free.dev',
  openBrowser: true,
  openBrowserDelayMs: 250,
  ngrokRestartBaseMs: 1000,
  ngrokRestartMaxMs: 30000,
  ngrokStableResetMs: 60000,
  ngrokProbeIntervalMs: 15000,
  ngrokProbeTimeoutMs: 5000,
  ngrokProbeStartupGraceMs: 5000,
  ngrokProbeFailureThreshold: 3,
  ngrokCollisionBackoffMs: 30000,
  ngrokLogMaxBytes: 131072,
};
const plan = buildStartAllPlan(options, 'all-token', 'all');

assert.equal(plan.mode, 'all');
assert.deepEqual(plan.processes.map((process) => process.label), ['server', 'ngrok']);
assert.deepEqual(plan.processes[0].args.slice(-2), ['run', 'dev:server']);
if (process.env.npm_execpath) {
  assert.equal(plan.processes[0].command, process.execPath);
  assert.equal(plan.processes[0].args[0], process.env.npm_execpath);
}
if (process.platform === 'win32') {
  assert.equal(plan.processes[1].command, 'cmd.exe');
  assert.deepEqual(plan.processes[1].args, ['/d', '/s', '/c', 'ngrok', 'http', '--domain=team-devflow.ngrok-free.dev', '3456']);
} else {
  assert.equal(plan.processes[1].command, 'ngrok');
  assert.deepEqual(plan.processes[1].args, ['http', '--domain=team-devflow.ngrok-free.dev', '3456']);
}
assert.equal(plan.appUrl, 'http://localhost:3456');
assert.equal(plan.openBrowser, true);
assert.equal(plan.openBrowserDelayMs, 250);

const serverProcess = plan.processes[0] as any;
assert.equal(serverProcess.env?.DEVFLOW_RESTART_SUPERVISOR, 'start-all');
assert.equal(serverProcess.env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'all-token');

const devPlan = buildStartAllPlan(options, 'dev-token', 'server-only');
assert.equal(devPlan.mode, 'server-only');
assert.deepEqual(devPlan.processes.map((process) => process.label), ['server']);
assert.deepEqual(devPlan.processes[0].args.slice(-2), ['run', 'dev:server']);
assert.equal(devPlan.openBrowser, false);
assert.equal((devPlan.processes[0] as any).env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN, 'dev-token');

assert.equal(typeof shouldRestartServerProcess, 'function');
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
  supervisorToken: 'wrong-token',
  shuttingDown: false,
  restartState: acceptedRestart,
}), false);
assert.equal(shouldRestartServerProcess({
  label: 'server',
  exitCode: 1,
  supervisorToken: 'supervisor-token',
  shuttingDown: false,
  restartState: acceptedRestart,
}), false);
assert.equal(shouldRestartServerProcess({
  label: 'server',
  exitCode: 75,
  supervisorToken: 'supervisor-token',
  shuttingDown: true,
  restartState: acceptedRestart,
}), false);

assert.equal(shouldRestartManagedProcess({ label: 'ngrok', mode: 'all', shuttingDown: false }), true);
assert.equal(shouldRestartManagedProcess({ label: 'ngrok', mode: 'all', shuttingDown: true }), false);
assert.equal(shouldRestartManagedProcess({ label: 'ngrok', mode: 'server-only', shuttingDown: false }), false);
assert.equal(shouldRestartManagedProcess({ label: 'server', mode: 'all', shuttingDown: false }), false);

assert.equal(computeManagedProcessRestartDelayMs(1, { baseMs: 1000, maxMs: 30000 }), 1000);
assert.equal(computeManagedProcessRestartDelayMs(2, { baseMs: 1000, maxMs: 30000 }), 2000);
assert.equal(computeManagedProcessRestartDelayMs(4, { baseMs: 1000, maxMs: 30000 }), 8000);
assert.equal(computeManagedProcessRestartDelayMs(20, { baseMs: 1000, maxMs: 30000 }), 30000);

const boundedOptions = resolveStartAllOptions({
  DEVFLOW_NGROK_RESTART_BASE_MS: '5000',
  DEVFLOW_NGROK_RESTART_MAX_MS: '1000',
  DEVFLOW_NGROK_STABLE_RESET_MS: '90000',
  DEVFLOW_OPEN_BROWSER: 'false',
});
assert.equal(boundedOptions.ngrokRestartBaseMs, 5000);
assert.equal(boundedOptions.ngrokRestartMaxMs, 5000);
assert.equal(boundedOptions.ngrokStableResetMs, 90000);
assert.equal(boundedOptions.openBrowser, false);

const collision = classifyNgrokDiagnosticLine('failed to start: ERR_NGROK_334 endpoint already online');
assert.equal(collision.errorCode, 'ERR_NGROK_334');
assert.equal(collision.classification, 'endpoint-session-collision');

assert.equal(
  sanitizeNgrokDiagnosticLine('url=https://secret.ngrok-free.app/path?token=abc123 authtoken=very-secret'),
  'url=[url] authtoken=[redacted]',
);

const generationA = resetDevFlowTunnelHealthForGeneration(undefined, 'A', {
  startupGraceMs: 0,
  now: '2026-08-13T00:00:00.000Z',
});
let lifecycleHealth = generationA;
for (const now of ['2026-08-13T00:00:01.000Z', '2026-08-13T00:00:02.000Z', '2026-08-13T00:00:03.000Z']) {
  lifecycleHealth = advanceDevFlowTunnelHealth(lifecycleHealth, { ok: false }, {
    failureThreshold: 3,
    generation: 'A',
    now,
  });
}
assert.equal(lifecycleHealth.status, 'down');
assert.equal(lifecycleHealth.consecutiveProbeFailures, 3);

lifecycleHealth = resetDevFlowTunnelHealthForGeneration(lifecycleHealth, 'B', {
  startupGraceMs: 5000,
  now: '2026-08-13T00:00:04.000Z',
});
assert.equal(lifecycleHealth.status, 'unknown');
assert.equal(lifecycleHealth.consecutiveProbeFailures, 0);
assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: false,
  startupGraceUntilMs: Date.parse(lifecycleHealth.startupGraceUntil!),
  nowMs: Date.parse('2026-08-13T00:00:05.000Z'),
}), false);

for (const [index, now] of ['2026-08-13T00:00:10.000Z', '2026-08-13T00:00:11.000Z'].entries()) {
  lifecycleHealth = advanceDevFlowTunnelHealth(lifecycleHealth, { ok: false }, {
    failureThreshold: 3,
    generation: 'B',
    now,
  });
  assert.equal(lifecycleHealth.status, 'degraded');
  assert.equal(lifecycleHealth.consecutiveProbeFailures, index + 1);
  assert.equal(shouldRecoverNgrokTunnel({
    tunnelStatus: lifecycleHealth.status,
    consecutiveProbeFailures: lifecycleHealth.consecutiveProbeFailures,
    failureThreshold: 3,
    localApiHealthy: true,
    ngrokProcessRunning: true,
    shuttingDown: false,
    nowMs: Date.parse(now),
  }), false);
}
lifecycleHealth = advanceDevFlowTunnelHealth(lifecycleHealth, { ok: false }, {
  failureThreshold: 3,
  generation: 'B',
  now: '2026-08-13T00:00:12.000Z',
});
assert.equal(lifecycleHealth.status, 'down');
assert.equal(lifecycleHealth.consecutiveProbeFailures, 3);
assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: lifecycleHealth.status,
  consecutiveProbeFailures: lifecycleHealth.consecutiveProbeFailures,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: false,
  nowMs: Date.parse('2026-08-13T00:00:12.000Z'),
}), true);

assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'degraded',
  consecutiveProbeFailures: 1,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: false,
  nowMs: 1000,
}), false);
assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: false,
  nowMs: 40000,
}), true);
assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: false,
  ngrokProcessRunning: true,
  shuttingDown: false,
  nowMs: 40000,
}), false);
assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: false,
  collisionBackoffUntilMs: 45000,
  nowMs: 40000,
}), false);

assert.equal(shouldRecoverNgrokTunnel({
  tunnelStatus: 'down',
  consecutiveProbeFailures: 3,
  failureThreshold: 3,
  localApiHealthy: true,
  ngrokProcessRunning: true,
  shuttingDown: true,
  nowMs: 40000,
}), false);

const diagnosticsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-ngrok-diagnostics-'));
const diagnosticsPath = path.join(diagnosticsRoot, 'ngrok-diagnostics.jsonl');
for (let index = 0; index < 30; index += 1) {
  appendNgrokDiagnosticRecord({
    filePath: diagnosticsPath,
    stream: index % 2 === 0 ? 'stdout' : 'stderr',
    line: `event=${index} url=https://secret.ngrok-free.app/path?token=abc${index} ERR_NGROK_334`,
    maxBytes: 1024,
    now: `2026-08-13T00:00:${String(index).padStart(2, '0')}.000Z`,
  });
}
const persistedDiagnostics = fs.readFileSync(diagnosticsPath, 'utf8');
assert.ok(Buffer.byteLength(persistedDiagnostics, 'utf8') <= 1024);
assert.doesNotMatch(persistedDiagnostics, /secret\.ngrok|abc\d+/i);
const persistedRecords = persistedDiagnostics.trim().split(/\r?\n/).map((line) => JSON.parse(line));
assert.ok(persistedRecords.length > 0);
assert.ok(persistedRecords.every((entry) => entry.errorCode === 'ERR_NGROK_334'));
assert.ok(persistedRecords.every((entry) => entry.classification === 'endpoint-session-collision'));
fs.rmSync(diagnosticsRoot, { recursive: true, force: true });

console.log('[verify-start-all] all assertions passed');
