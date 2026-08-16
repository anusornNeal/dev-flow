import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

export type ContextBudgetQualityReport = {
  baselineBytes: number;
  unchangedBytes: number;
  recoveryBytes: number;
  totalOptimizedBytes: number;
  bytesSaved: number;
  savingsPercent: number;
  baselineEstimatedTokens: number;
  optimizedEstimatedTokens: number;
  followUpCalls: number;
  missedContextRecoveries: number;
  recoverySuccess: boolean;
  baselineSuccessRate: number;
  optimizedSuccessRate: number;
  successRateDelta: number;
  unchangedStatus: string;
  recoveryStatus: string;
  governorBytes: number;
  governorReuseCount: number;
  governorExpansionCount: number;
};

export async function runContextBudgetQualityBenchmark(): Promise<ContextBudgetQualityReport> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-context-budget-benchmark-'));
  const dbPath = path.join(os.tmpdir(), `devflow-context-budget-benchmark-${path.basename(root)}.sqlite`);
  const previousDbPath = process.env.DEVFLOW_DB_PATH;
  process.env.DEVFLOW_DB_PATH = dbPath;

  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    const filler = Array.from({ length: 120 }, (_, index) => `export const benchmarkFiller${index} = ${index};`);
    fs.writeFileSync(path.join(root, 'src', 'Benchmark.ts'), [
      'export function BenchmarkEntry() { return 1; }',
      ...filler,
      'export function DeepBenchmarkHelper() { return 99; }',
    ].join('\n'), 'utf8');
    git(root, ['init']);
    git(root, ['config', 'user.name', 'DevFlow Benchmark']);
    git(root, ['config', 'user.email', 'devflow-benchmark@example.com']);
    git(root, ['add', '.']);
    git(root, ['commit', '-m', 'benchmark fixture']);

    const { executeAllMigrations } = await import('../src/db/migrations/index.js');
    executeAllMigrations();
    const { createProject } = await import('../src/server/repositories/projectRepository.js');
    const { clearContextHandles, getRepoContextWithHandle } = await import('../src/server/services/contextHandleService.js');
    const { stopAllRepoChangeWatchers } = await import('../src/server/services/workspaceChangeWatcherService.js');
    const project = { id: `project-${path.basename(root)}`, name: 'Context Budget Benchmark', repoUrl: 'https://example.com/context-budget-benchmark', localPath: root };
    createProject(project);
    const state: any = { projectsCache: [project] };
    const args = { projectId: project.id, q: 'fix BenchmarkEntry function bug', intent: 'small-bug' };

    const initial: any = getRepoContextWithHandle(state, args);
    const unchanged: any = getRepoContextWithHandle(state, { ...args, contextHandle: initial.contextHandle });
    const recovery: any = getRepoContextWithHandle(state, {
      ...args,
      contextHandle: initial.contextHandle,
      contextSufficient: false,
      missingSymbols: ['DeepBenchmarkHelper'],
    });

    const baselineBytes = byteSize(initial);
    const unchangedBytes = byteSize(unchanged);
    const recoveryBytes = byteSize(recovery);
    const governorBytes = byteSize(initial.contextGovernor) + byteSize(unchanged.contextGovernor) + byteSize(recovery.contextGovernor);
    const governorReuseCount = [initial, unchanged, recovery].filter((entry) => entry.contextGovernor?.delivery?.mode === 'reuse-handle').length;
    const governorExpansionCount = [initial, unchanged, recovery].filter((entry) => entry.contextGovernor?.expansion?.requested === true).length;
    const totalOptimizedBytes = unchangedBytes + recoveryBytes;
    const bytesSaved = Math.max(0, baselineBytes * 2 - totalOptimizedBytes);
    const recoverySuccess = recovery.status === 'delta' && recovery.changedSnippets?.some((entry: any) => String(entry.content || '').includes('DeepBenchmarkHelper'));
    const baselineSuccessRate = 100;
    const optimizedSuccessRate = recoverySuccess && unchanged.status === 'not_modified' ? 100 : 50;
    const report: ContextBudgetQualityReport = {
      baselineBytes,
      unchangedBytes,
      recoveryBytes,
      totalOptimizedBytes,
      bytesSaved,
      savingsPercent: Math.round((bytesSaved / Math.max(1, baselineBytes * 2)) * 10_000) / 100,
      baselineEstimatedTokens: Math.ceil((baselineBytes * 2) / 4),
      optimizedEstimatedTokens: Math.ceil(totalOptimizedBytes / 4),
      followUpCalls: Number(recovery.metrics?.followUpCalls || 0),
      missedContextRecoveries: 1,
      recoverySuccess,
      baselineSuccessRate,
      optimizedSuccessRate,
      successRateDelta: optimizedSuccessRate - baselineSuccessRate,
      unchangedStatus: String(unchanged.status),
      recoveryStatus: String(recovery.status),
      governorBytes,
      governorReuseCount,
      governorExpansionCount,
    };
    stopAllRepoChangeWatchers();
    clearContextHandles();
    return report;
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(dbPath, { force: true }); } catch {}
    if (previousDbPath === undefined) delete process.env.DEVFLOW_DB_PATH;
    else process.env.DEVFLOW_DB_PATH = previousDbPath;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const report = await runContextBudgetQualityBenchmark();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
