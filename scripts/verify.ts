import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDbDir, 'devflow.db');

const MAX_STEP_OUTPUT_BYTES = 20_000;

function outputBytes(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function capOutput(value: string) {
  const bytes = outputBytes(value);
  if (bytes <= MAX_STEP_OUTPUT_BYTES) return value;
  return `${Buffer.from(value, 'utf8').subarray(0, MAX_STEP_OUTPUT_BYTES).toString('utf8')}\n[truncated]`;
}

function emitFailureOutput(label: string, stdout: string, stderr: string) {
  if (stdout.trim()) console.error(`[verify] ${label} stdout:\n${capOutput(stdout)}`);
  if (stderr.trim()) console.error(`[verify] ${label} stderr:\n${capOutput(stderr)}`);
}

const commands = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'] },
  { label: 'project atlas cache', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasCacheService.test.ts'] },
  { label: 'project atlas domains', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasDomainService.test.ts'] },
  { label: 'project atlas scanner', command: 'npx', args: ['tsx', '--test', 'tests/server/projectAtlasScannerService.test.ts'] },
  { label: 'project command service', command: 'npx', args: ['tsx', '--test', 'tests/server/projectCommandService.test.ts'] },
  { label: 'mcp fetch errors', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpFetchErrors.test.ts'] },
  { label: 'mcp tool job queue', command: 'npx', args: ['tsx', '--test', 'tests/server/mcpToolJobQueue.test.ts'] },
  { label: 'agent runs', command: 'npm', args: ['run', 'test:agent-runs'] },
  { label: 'figma integration', command: 'npm', args: ['run', 'test:figma'] },
  { label: 'gateway safety', command: 'npm', args: ['run', 'test:gateway'] },
  { label: 'start all launcher', command: 'npm', args: ['run', 'test:start-all'] },
  { label: 'absolute paths', command: 'npm', args: ['run', 'test:absolute-paths'] },
  { label: 'prompt templates', command: 'npm', args: ['run', 'test:prompt-templates'] },
  { label: 'orchestration', command: 'npm', args: ['run', 'test:orchestration'] },
  { label: 'sqlite persistence', command: 'npm', args: ['run', 'test:sqlite'] },
  { label: 'doctor', command: 'npm', args: ['run', 'doctor'] },
];

for (const step of commands) {
  console.log(`[verify] Running ${step.label}...`);
  const executable = process.platform === 'win32' ? 'cmd.exe' : step.command;
  const finalArgs = process.platform === 'win32' ? ['/c', step.command, ...step.args] : step.args;
  const result = spawnSync(executable, finalArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    shell: false,
    stdio: 'pipe',
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  if (result.error) {
    console.error(`[verify] ${step.label} could not run: ${result.error.message}`);
    emitFailureOutput(step.label, stdout, stderr);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`[verify] ${step.label} failed with exit ${result.status ?? 'unknown'}.`);
    emitFailureOutput(step.label, stdout, stderr);
    process.exit(result.status ?? 1);
  }

  console.log(`[verify] ${step.label} passed (${outputBytes(stdout)} stdout bytes, ${outputBytes(stderr)} stderr bytes).`);
}

console.log('[verify] Verification completed successfully.');
