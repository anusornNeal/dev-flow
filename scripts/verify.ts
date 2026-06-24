import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
const tempDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-test-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDbDir, 'devflow.db');


const commands = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'] },
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
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log('[verify] Verification completed successfully.');
