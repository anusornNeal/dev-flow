import assert from 'node:assert/strict';
import fs from 'node:fs';

const packageJson = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(packageJson.scripts.dev, 'tsx scripts/start-all.ts --server-only');
assert.equal(packageJson.scripts['dev:server'], 'tsx server.ts');
assert.equal(packageJson.scripts['start:all'], 'tsx scripts/start-all.ts');

const {
  buildNgrokArgs,
  buildNpmInvocation,
  buildStartAllPlan,
  computeManagedProcessRestartDelayMs,
  resolveStartAllOptions,
  shouldRestartServerProcess,
  shouldRestartManagedProcess,
} = await import('./start-all');

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
});

const options = {
  port: 3456,
  ngrokDomain: 'team-devflow.ngrok-free.dev',
  openBrowser: true,
  openBrowserDelayMs: 250,
  ngrokRestartBaseMs: 1000,
  ngrokRestartMaxMs: 30000,
  ngrokStableResetMs: 60000,
};
const plan = buildStartAllPlan(options, 'all-token', 'all');

assert.equal(plan.mode, 'all');
assert.deepEqual(plan.processes.map((process) => process.label), ['server', 'ngrok']);
assert.deepEqual(plan.processes[0].args.slice(-2), ['run', 'dev:server']);
if (process.env.npm_execpath) {
  assert.equal(plan.processes[0].command, process.execPath);
  assert.equal(plan.processes[0].args[0], process.env.npm_execpath);
}
assert.deepEqual(plan.processes[1].args, ['http', '--domain=team-devflow.ngrok-free.dev', '3456']);
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

console.log('[verify-start-all] all assertions passed');
