const fs = require('fs');

function extractPromptPath(args) {
  const promptArg = args.find((value) => value.startsWith('Read and follow the DevFlow prompt file at: '));
  if (!promptArg) return '';
  return promptArg.replace('Read and follow the DevFlow prompt file at: ', '').trim();
}

const args = process.argv.slice(2);
const promptPath = extractPromptPath(args);
const prompt = promptPath && fs.existsSync(promptPath) ? fs.readFileSync(promptPath, 'utf8') : '';
const mode = process.env.DEVFLOW_FAKE_CODEX_MODE || 'success';
const exitCode = Number.parseInt(process.env.DEVFLOW_FAKE_CODEX_EXIT_CODE || '0', 10) || 0;

if (mode === 'error') {
  process.stderr.write(`FAKE_CODEX_RESULT error promptPath=${promptPath}\n`);
  process.stderr.write(prompt);
  process.exit(exitCode || 1);
}

process.stdout.write(`FAKE_CODEX_RESULT success promptPath=${promptPath}\n`);
process.stdout.write(prompt);
process.exit(0);
