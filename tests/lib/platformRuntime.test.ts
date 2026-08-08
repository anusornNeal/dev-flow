import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normalizeLocalPathIdentity,
  resolvePackageManagerInvocation,
} from '../../src/lib/platformRuntime.js';

test('portable local-path identity handles Windows-looking and POSIX-looking inputs deterministically', () => {
  assert.equal(normalizeLocalPathIdentity('C:\\Work\\Repo\\', 'win32'), 'c:/work/repo');
  assert.equal(normalizeLocalPathIdentity('C:/Work/Repo', 'linux'), 'C:/Work/Repo');
  assert.equal(normalizeLocalPathIdentity('/Users/Test/Repo/', 'darwin'), '/Users/Test/Repo');
});

test('package manager invocation uses argument arrays and avoids shell strings', () => {
  const posix = resolvePackageManagerInvocation('npm', ['run', '--silent', 'test'], { platform: 'darwin', execPath: '/usr/bin/node', env: {} });
  assert.deepEqual(posix, { executable: 'npm', args: ['run', '--silent', 'test'], shell: false });

  const win = resolvePackageManagerInvocation('npm', ['run', '--silent', 'test'], {
    platform: 'win32',
    execPath: 'C:\\Node\\node.exe',
    env: { npm_execpath: 'C:\\Node\\node_modules\\npm\\bin\\npm-cli.js' },
  });
  assert.equal(win.executable, 'C:\\Node\\node.exe');
  assert.deepEqual(win.args, ['C:\\Node\\node_modules\\npm\\bin\\npm-cli.js', 'run', '--silent', 'test']);
  assert.equal(win.shell, false);
});

test('runtime path normalization never depends on the current developer home', () => {
  const resolved = normalizeLocalPathIdentity(path.join('/tmp', 'repo'), 'linux');
  assert.equal(resolved, '/tmp/repo');
});
