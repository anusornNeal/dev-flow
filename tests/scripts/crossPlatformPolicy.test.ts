import test from 'node:test';
import assert from 'node:assert/strict';
import { findCrossPlatformViolations } from '../../scripts/crossPlatformPolicy.js';

test('cross-platform guard rejects developer-specific absolute paths and shell execution in shared runtime code', () => {
  const violations = findCrossPlatformViolations('src/server/services/example.ts', `
    const a = 'C:\\Users\\someone\\repo';
    const b = '/Users/someone/repo';
    spawn('tool', [], { shell: true });
  `);
  assert.deepEqual(violations.map((entry) => entry.code).sort(), ['HARDCODED_HOME_PATH', 'HARDCODED_HOME_PATH', 'SHELL_TRUE_SHARED_RUNTIME'].sort());
});

test('portable runner is subject to the same cross-platform path guard', () => {
  assert.deepEqual(
    findCrossPlatformViolations('src/runner.ts', `powershell.exe C:\\Users\\someone`).map((entry) => entry.code),
    ['HARDCODED_HOME_PATH'],
  );
});

test('normal portable path and shell:false code passes', () => {
  assert.deepEqual(findCrossPlatformViolations('src/server/services/example.ts', `path.join(os.tmpdir(), 'x'); spawn('git', ['status'], { shell: false });`), []);
});
