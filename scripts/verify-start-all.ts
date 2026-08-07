import assert from 'node:assert/strict';

const {
  buildNgrokArgs,
  buildStartAllPlan,
  resolveStartAllOptions,
  shouldRestartServerProcess,
} = await import('./start-all');

assert.deepEqual(buildNgrokArgs({ port: 3000, domain: 'example.ngrok-free.dev' }), [
  'http',
  '--domain=example.ngrok-free.dev',
  '3000',
]);

assert.deepEqual(buildNgrokArgs({ port: 3000, domain: '' }), ['http', '3000']);

assert.deepEqual(resolveStartAllOptions({
  DEVFLOW_PORT: '3456',
  DEVFLOW_NGROK_DOMAIN: 'team-devflow.ngrok-free.dev',
  DEVFLOW_OPEN_BROWSER_DELAY_MS: '250',
}), {
  port: 3456,
  ngrokDomain: 'team-devflow.ngrok-free.dev',
  openBrowser: true,
  openBrowserDelayMs: 250,
});

const plan = buildStartAllPlan({
  port: 3456,
  ngrokDomain: 'team-devflow.ngrok-free.dev',
  openBrowser: true,
  openBrowserDelayMs: 250,
});

assert.deepEqual(plan.processes.map((process) => process.label), ['server', 'ngrok']);
assert.deepEqual(plan.processes[0].args, ['run', 'dev']);
assert.deepEqual(plan.processes[1].args, ['http', '--domain=team-devflow.ngrok-free.dev', '3456']);
assert.equal(plan.appUrl, 'http://localhost:3456');
assert.equal(plan.openBrowserDelayMs, 250);

const serverProcess = plan.processes[0] as any;
assert.equal(serverProcess.env?.DEVFLOW_RESTART_SUPERVISOR, 'start-all');
assert.ok(serverProcess.env?.DEVFLOW_RESTART_SUPERVISOR_TOKEN);

assert.equal(typeof shouldRestartServerProcess, 'function');
const acceptedRestart = {
  ticket: 'restart-test',
  status: 'accepted',
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

console.log('[verify-start-all] all assertions passed');
