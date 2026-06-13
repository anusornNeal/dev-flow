import { spawnSync } from 'child_process';

const commands = [
  { label: 'lint', command: 'npm', args: ['run', 'lint'] },
  { label: 'devflow contract', command: 'npx', args: ['tsx', 'scripts/verify-devflow-contract.ts'] },
  { label: 'agent runs', command: 'npm', args: ['run', 'test:agent-runs'] },
  { label: 'prompt templates', command: 'npm', args: ['run', 'test:prompt-templates'] },
  { label: 'orchestration', command: 'npm', args: ['run', 'test:orchestration'] },
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
