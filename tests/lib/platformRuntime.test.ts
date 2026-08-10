import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureSystemResourceSnapshot,
  diffSystemResourceSnapshots,
  getMachineRuntimeProfile,
  normalizeLocalPathIdentity,
  resolvePackageManagerInvocation,
  sampleProcessTreeResources,
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
  const resolved = normalizeLocalPathIdentity('/tmp/repo', 'linux');
  assert.equal(resolved, '/tmp/repo');
});

test('machine runtime profile is stable, hardware-specific and path-free', () => {
  const input = {
    platform: 'win32' as const,
    arch: 'x64',
    runtimeVersion: 'v24.16.0',
    cpuModels: ['AMD Ryzen Test', 'AMD Ryzen Test'],
    totalMemoryBytes: 32 * 1024 ** 3,
  };
  const first = getMachineRuntimeProfile(input);
  const second = getMachineRuntimeProfile(input);
  const different = getMachineRuntimeProfile({ ...input, cpuModels: ['Different CPU', 'Different CPU'] });

  assert.equal(first.key, second.key);
  assert.notEqual(first.key, different.key);
  assert.equal(first.cpuCount, 2);
  assert.equal(first.runtimeMajor, 24);
  assert.equal(JSON.stringify(first).includes('Users'), false);
  assert.equal('cpuModel' in first, false);
});

test('system resource delta reports bounded CPU utilization and memory pressure', () => {
  const start = captureSystemResourceSnapshot({
    now: 1_000,
    cpuTimes: [{ user: 300, nice: 0, sys: 200, idle: 500, irq: 0 }],
    totalMemoryBytes: 1_000,
    freeMemoryBytes: 400,
  });
  const end = captureSystemResourceSnapshot({
    now: 2_000,
    cpuTimes: [{ user: 500, nice: 0, sys: 300, idle: 600, irq: 0 }],
    totalMemoryBytes: 1_000,
    freeMemoryBytes: 200,
  });
  const delta = diffSystemResourceSnapshots(start, end);

  assert.equal(delta.durationMs, 1_000);
  assert.equal(delta.cpuUtilization, 0.75);
  assert.equal(delta.memoryPressureStart, 0.6);
  assert.equal(delta.memoryPressureEnd, 0.8);
  assert.equal(delta.peakMemoryPressure, 0.8);
});

test('POSIX process sampling accounts for descendants and normalizes CPU by machine cores', () => {
  const sample = sampleProcessTreeResources(100, {
    platform: 'darwin',
    cpuCount: 4,
    run: () => ({
      status: 0,
      stdout: [
        '100 1 1000 20.0',
        '101 100 2000 30.0',
        '102 101 3000 50.0',
        '999 1 9000 80.0',
      ].join('\n'),
    }),
  });

  assert.equal(sample.supported, true);
  assert.equal(sample.treeAccounting, true);
  assert.equal(sample.processCount, 3);
  assert.equal(sample.rssBytes, 6_000 * 1024);
  assert.equal(sample.cpuRatio, 0.25);
});

test('Windows process sampling uses a safe main-process memory fallback', () => {
  const sample = sampleProcessTreeResources(123, {
    platform: 'win32',
    cpuCount: 8,
    run: () => ({ status: 0, stdout: '"node.exe","123","Console","1","12,345 K"' }),
  });

  assert.equal(sample.supported, true);
  assert.equal(sample.treeAccounting, false);
  assert.equal(sample.processCount, 1);
  assert.equal(sample.rssBytes, 12_345 * 1024);
  assert.equal(sample.cpuRatio, undefined);
});

test('process sampling degrades safely when platform signals are unavailable', () => {
  const failed = sampleProcessTreeResources(321, {
    platform: 'darwin',
    run: () => ({ status: 1, stdout: '', stderr: 'missing ps' }),
  });
  const unsupported = sampleProcessTreeResources(321, { platform: 'aix' });

  assert.equal(failed.supported, false);
  assert.equal(failed.reason, 'sampler-failed');
  assert.equal(unsupported.supported, false);
  assert.equal(unsupported.reason, 'unsupported-platform');
});
