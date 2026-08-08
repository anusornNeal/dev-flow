import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-verification-benchmark-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'benchmark.sqlite');
let closeDatabase: (() => void) | null = null;

const now = () => Date.now();
const compactCommandMetrics = (result: any, wallMs: number) => ({
  ok: result?.ok === true,
  wallMs,
  executionMs: Number(result?.performance?.executionMs ?? result?.durationMs ?? 0),
  resolutionMs: Number(result?.performance?.resolutionMs ?? 0),
  processSpawns: Number(result?.processSpawns ?? 0),
  cacheHit: result?.cache?.hit === true,
});

function git(repo: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

try {
  const { executeAllMigrations } = await import('../src/db/migrations/index.js');
  const { default: db } = await import('../src/db/index.js');
  closeDatabase = () => db.close();
  executeAllMigrations();
  const { createProject } = await import('../src/server/repositories/projectRepository.js');
  const { runProjectCommand } = await import('../src/server/services/projectCommandService.js');
  const { applyAndVerifyAsync } = await import('../src/server/services/applyAndVerifyService.js');
  const { enqueueToolJob, getQueueMetrics, waitForToolJob } = await import('../src/server/services/mcpToolJobService.js');
  const { readJobResult } = await import('../src/server/repositories/mcpToolJobRepository.js');

  const state: any = {
    projectsCache: [{ id: 'benchmark-devflow', name: 'DevFlow Benchmark', repoUrl: 'https://example.com/devflow', localPath: root }],
  };
  createProject({ id: 'benchmark-devflow', name: 'DevFlow Benchmark', repoUrl: 'https://example.com/devflow', localPath: root });

  let startedAt = now();
  const coldTypecheckResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  });
  const coldTypecheck = compactCommandMetrics(coldTypecheckResult, now() - startedAt);

  startedAt = now();
  const warmTypecheckResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
  });
  const warmTypecheck = compactCommandMetrics(warmTypecheckResult, now() - startedAt);

  startedAt = now();
  const semanticAliasResult = runProjectCommand(state, {
    projectId: 'benchmark-devflow',
    command: 'lint',
    responseMode: 'compact',
  });
  const semanticAlias = compactCommandMetrics(semanticAliasResult, now() - startedAt);

  const beforeSingleFlight = getQueueMetrics().metrics.singleFlightHits;
  startedAt = now();
  const firstJob = enqueueToolJob(state, 'run_project_command', {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  }, 'repo-command');
  const secondJob = enqueueToolJob(state, 'run_project_command', {
    projectId: 'benchmark-devflow',
    command: 'typecheck',
    responseMode: 'compact',
    forceFresh: true,
  }, 'repo-command');
  await Promise.all([
    waitForToolJob(firstJob.jobId, 30_000),
    waitForToolJob(secondJob.jobId, 30_000),
  ]);
  const concurrentWallMs = now() - startedAt;
  const firstJobResult = readJobResult(firstJob.jobId)?.result as any;
  const afterSingleFlight = getQueueMetrics().metrics.singleFlightHits;
  const concurrentTypecheck = {
    ok: firstJobResult?.ok === true,
    wallMs: concurrentWallMs,
    sharedWith: secondJob.sharedWith || null,
    singleFlightHits: afterSingleFlight - beforeSingleFlight,
    underlyingProcessSpawns: Number(firstJobResult?.processSpawns ?? 0),
  };

  const targetedRoot = path.join(tempRoot, 'targeted-repo');
  fs.mkdirSync(path.join(targetedRoot, 'src'), { recursive: true });
  fs.mkdirSync(path.join(targetedRoot, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(targetedRoot, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(targetedRoot, 'src', 'value.ts'), 'export const value = 1;\n', 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'scripts', 'a.mjs'), "await new Promise((resolve) => setTimeout(resolve, 500));\n", 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'scripts', 'b.mjs'), "await new Promise((resolve) => setTimeout(resolve, 500));\n", 'utf8');
  fs.writeFileSync(path.join(targetedRoot, 'package.json'), JSON.stringify({ type: 'module' }, null, 2), 'utf8');
  fs.writeFileSync(path.join(targetedRoot, '.devflow', 'commands.yaml'), [
    'commands:',
    '  target-a:',
    '    executable: node',
    '    args:',
    '      - scripts/a.mjs',
    '    category: test',
    '  target-b:',
    '    executable: node',
    '    args:',
    '      - scripts/b.mjs',
    '    category: test',
    '',
  ].join('\n'), 'utf8');
  git(targetedRoot, ['init']);
  git(targetedRoot, ['config', 'user.name', 'DevFlow Benchmark']);
  git(targetedRoot, ['config', 'user.email', 'devflow-benchmark@example.com']);
  git(targetedRoot, ['add', '.']);
  git(targetedRoot, ['commit', '-m', 'initial']);
  createProject({ id: 'benchmark-targeted', name: 'Targeted Benchmark', repoUrl: 'https://example.com/targeted', localPath: targetedRoot });
  const targetedState: any = {
    projectsCache: [{ id: 'benchmark-targeted', name: 'Targeted Benchmark', repoUrl: 'https://example.com/targeted', localPath: targetedRoot }],
  };
  startedAt = now();
  const targetedResult = await applyAndVerifyAsync(targetedState, {
    projectId: 'benchmark-targeted',
    files: [{ filePath: 'src/value.ts', edits: [{ type: 'replace', find: 'value = 1', replaceWith: 'value = 2' }] }],
    requestedCommands: ['target-a', 'target-b'],
    cacheVerificationResults: false,
    forceFresh: true,
  });
  const targetedWallMs = now() - startedAt;
  const targeted = {
    ok: targetedResult.ok === true,
    wallMs: targetedWallMs,
    summedExecutionMs: Number(targetedResult.verificationPerformance?.summedExecutionMs ?? 0),
    processSpawns: Number(targetedResult.verificationPerformance?.processSpawns ?? 0),
    parallelVerification: targetedResult.parallelVerification === true,
  };

  let full: any = null;
  if (process.argv.includes('--full')) {
    startedAt = now();
    const executable = process.platform === 'win32' ? 'cmd.exe' : 'npm';
    const args = process.platform === 'win32' ? ['/c', 'npm', 'run', 'verify'] : ['run', 'verify'];
    const result = spawnSync(executable, args, {
      cwd: root,
      encoding: 'utf8',
      shell: false,
      timeout: 300_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    full = {
      ok: result.status === 0,
      wallMs: now() - startedAt,
      exitCode: result.status,
      stdoutBytes: Buffer.byteLength(result.stdout || '', 'utf8'),
      stderrBytes: Buffer.byteLength(result.stderr || '', 'utf8'),
      tail: `${result.stdout || ''}\n${result.stderr || ''}`.slice(-4000),
    };
  }

  const report = {
    generatedAt: new Date().toISOString(),
    baseline: {
      recentRunProjectCommandP50Ms: 11_987,
      recentRunProjectCommandP95Ms: 20_130,
      preChangeColdTypecheckMs: 7_336,
      preChangeColdLintMs: 7_391,
      preChangeIncompleteFullVerifyMs: 70_471,
    },
    after: {
      coldTypecheck,
      warmTypecheck,
      semanticAlias,
      concurrentTypecheck,
      targeted,
      full,
    },
  };

  console.log(JSON.stringify(report, null, 2));
} finally {
  try {
    closeDatabase?.();
  } catch (error) {
    console.error(`[benchmark] database close warning: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.error(`[benchmark] cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
  }
}
