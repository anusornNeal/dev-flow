import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildStartAllPlan, resolveStartAllOptions } from '../../scripts/start-all.js';

function withDisableHmr(value: string | undefined, run: () => void) {
  const previous = process.env.DISABLE_HMR;
  if (value === undefined) delete process.env.DISABLE_HMR;
  else process.env.DISABLE_HMR = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.DISABLE_HMR;
    else process.env.DISABLE_HMR = previous;
  }
}

test('operational start-all disables HMR and source watching by default', () => {
  withDisableHmr(undefined, () => {
    const plan = buildStartAllPlan(resolveStartAllOptions({ DEVFLOW_OPEN_BROWSER: 'false' } as NodeJS.ProcessEnv), 'test-token', 'server-only');
    assert.equal(plan.processes[0]?.env?.DISABLE_HMR, 'true');
  });
});

test('explicit developer override can keep HMR enabled', () => {
  withDisableHmr('false', () => {
    const plan = buildStartAllPlan(resolveStartAllOptions({ DEVFLOW_OPEN_BROWSER: 'false' } as NodeJS.ProcessEnv), 'test-token', 'server-only');
    assert.equal(plan.processes[0]?.env?.DISABLE_HMR, 'false');
  });
});

test('inline Vite middleware honors DISABLE_HMR on Windows and non-Windows paths', () => {
  const source = fs.readFileSync('server.ts', 'utf8');
  assert.match(source, /const disableHmr = process\.env\.DISABLE_HMR === 'true'/);
  assert.match(source, /hmr: disableHmr \? false/);
  assert.match(source, /watch: disableHmr \? null/);
  assert.match(source, /cacheDir: path\.join\(getDevFlowRuntimeDir\(\), 'vite-cache'\)/);
  assert.match(source, /dedupe: \['react', 'react-dom'\]/);
});
