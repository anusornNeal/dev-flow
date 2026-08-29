import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const source = fs.readFileSync(path.join(root, 'src/server/useCases/agentRunUseCases.ts'), 'utf8');

test('legacy retry/cancel/completion use cases stay retired', () => {
  assert.doesNotMatch(source, /function\s+canRetryRun/);
  assert.doesNotMatch(source, /function\s+canCancelRun/);
  assert.doesNotMatch(source, /function\s+validateCompletion/);
  assert.match(source, /retired/i);
});
