import assert from 'node:assert/strict';

const {
  buildNgrokArgs,
  buildStartAllPlan,
  resolveStartAllOptions,
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

console.log('[verify-start-all] all assertions passed');
