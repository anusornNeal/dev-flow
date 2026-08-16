import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

function resolveTsxCli() {
  const candidates = [
    path.resolve('node_modules/tsx/dist/cli.mjs'),
    path.resolve('../../../../../node_modules/tsx/dist/cli.mjs'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) throw new Error(`tsx CLI not found. Checked: ${candidates.join(', ')}`);
  return resolved;
}

const tsxCli = resolveTsxCli();

const checks = [
  ['chatgpt harness integration', ['--test', 'tests/server/chatgptHarnessIntegration.test.ts']],
  ['execution session handoff', ['--test', 'tests/server/executionSessionHandoff.test.ts']],
  ['context governor', ['--test', 'tests/server/contextGovernorService.test.ts']],
  ['harness policy', ['--test', 'tests/server/harnessPolicyService.test.ts']],
  ['harness enforcement', ['--test', 'tests/server/harnessPolicyEnforcement.test.ts']],
  ['harness strategy', ['--test', 'tests/server/harnessStrategyService.test.ts']],
  ['verification planner', ['--test', 'tests/server/verificationPlannerService.test.ts']],
  ['task workspace finalization', ['--test', 'tests/server/taskWorkspaceFinalizationService.test.ts']],
  ['harness benchmark', ['scripts/benchmark-chatgpt-harness.ts']],
] as const;

const results: Array<{ name: string; ok: boolean; durationMs: number }> = [];
let failed = false;

for (const [name, args] of checks) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [tsxCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    shell: false,
    env: {
      ...process.env,
      DEVFLOW_CHATGPT_HARNESS_VERIFY: '1',
    },
  });
  const durationMs = Date.now() - startedAt;
  const ok = result.status === 0;
  results.push({ name, ok, durationMs });
  process.stdout.write(`[chatgpt-harness] ${ok ? 'PASS' : 'FAIL'} ${name} (${durationMs}ms)\n`);
  if (!ok) {
    failed = true;
    if (result.stdout) process.stdout.write(result.stdout.slice(-12_000));
    if (result.stderr) process.stderr.write(result.stderr.slice(-12_000));
    break;
  }
}

const passed = results.filter((entry) => entry.ok).length;
process.stdout.write(`${JSON.stringify({
  schemaVersion: 1,
  gate: 'devflow-chatgpt-harness',
  networkModelCallRequired: false,
  passed,
  attempted: results.length,
  total: checks.length,
  failed: results.filter((entry) => !entry.ok).map((entry) => entry.name),
  results,
})}\n`);

if (failed || results.length !== checks.length) process.exitCode = 1;
