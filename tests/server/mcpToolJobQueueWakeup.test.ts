import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-queue-wakeup-'));
const previousEnv = {
  dbPath: process.env.DEVFLOW_DB_PATH,
  jobsDir: process.env.DEVFLOW_JOBS_DIR,
  runtimeDir: process.env.DEVFLOW_RUNTIME_DIR,
};
process.env.DEVFLOW_DB_PATH = path.join(testRoot, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(testRoot, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(testRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { default: db } = await import('../../src/db/index.js');
executeAllMigrations();
const jobService = await import('../../src/server/services/mcpToolJobService.js');
const projectCommands = await import('../../src/server/services/projectCommandService.js');
const resourceProfiles = await import('../../src/server/services/verificationResourceProfileService.js');
const scheduler = await import('../../src/server/services/mcpToolJobScheduler.js');

function restoreEnv(name: 'DEVFLOW_DB_PATH' | 'DEVFLOW_JOBS_DIR' | 'DEVFLOW_RUNTIME_DIR', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitUntil(predicate: () => boolean, message: string, retries = 80) {
  for (let index = 0; index < retries; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(testRoot, { recursive: true, force: true });
  restoreEnv('DEVFLOW_DB_PATH', previousEnv.dbPath);
  restoreEnv('DEVFLOW_JOBS_DIR', previousEnv.jobsDir);
  restoreEnv('DEVFLOW_RUNTIME_DIR', previousEnv.runtimeDir);
});

test('queued verification self-rechecks after external machine pressure clears without a scheduler wake event', async () => {
  const repoRoot = fs.mkdtempSync(path.join(testRoot, 'repo-'));
  fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ scripts: { typecheck: 'node -e "0"' } }));
  const projectId = `queue-wakeup-${randomUUID()}`;
  const state = { projects: [{ id: projectId, name: 'Queue wakeup fixture', localPath: repoRoot }] } as any;

  resourceProfiles.clearVerificationResourceProfilesForTests();
  scheduler.resetSchedulerResourceStateForTests();
  scheduler.setGlobalVerifyCapacityForTests(2);
  scheduler.setVerificationResourceBudgetForTests({
    targetCpuRatio: 0.75,
    hardCpuRatio: 0.95,
    targetMemoryPressure: 0.8,
    hardMemoryPressure: 0.95,
    maxAdaptiveProcesses: 4,
  });

  const described = projectCommands.describeProjectCommandResourceProfile(state, { localPath: repoRoot, command: 'typecheck' });
  for (let index = 0; index < 4; index += 1) {
    const predicted = resourceProfiles.predictVerificationResourceCost(described.resourceDescriptor);
    resourceProfiles.recordVerificationResourceSample(described.resourceDescriptor, {
      status: 'succeeded',
      durationMs: 1_000 + index * 100,
      cpuRatio: 0.1,
      memoryBytes: 64 * 1024 ** 2,
      processCount: 1,
      systemCpuRatio: 0.2,
      memoryPressureRatio: 0.3,
      treeAccounting: true,
      predicted,
      recordedAt: Date.now() + index,
    });
  }
  assert.match(resourceProfiles.predictVerificationResourceCost(described.resourceDescriptor).confidence, /medium|high/);
  scheduler.setVerificationMachinePressureForTests({
    cpuRatio: 0.85,
    memoryPressureRatio: 0.3,
    totalMemoryBytes: 8 * 1024 ** 3,
  });

  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  jobService.__setToolJobTestRunner('run_project_command', async () => {
    resolveStarted();
    return { ok: true, status: 'succeeded' };
  });

  let jobId = '';
  try {
    const accepted = jobService.enqueueToolJob(state, 'run_project_command', {
      localPath: repoRoot,
      command: 'typecheck',
      singleFlight: false,
    }, 'repo-command');
    jobId = accepted.jobId;

    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(jobService.getToolJobStatus(jobId)?.status, 'queued');
    assert.equal((jobService.getToolJobStatus(jobId) as any)?.blockReason, 'live_pressure_saturated');

    scheduler.setVerificationMachinePressureForTests({
      cpuRatio: 0.2,
      memoryPressureRatio: 0.3,
      totalMemoryBytes: 8 * 1024 ** 3,
    });

    await Promise.race([
      started,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Queued verification did not self-recheck after external machine pressure cleared.')), 1_250)),
    ]);
    await waitUntil(() => jobService.getToolJobStatus(jobId)?.status === 'succeeded', 'Expected rechecked verification to finish');
  } finally {
    if (jobId && jobService.getToolJobStatus(jobId)?.status === 'queued') jobService.cancelToolJob(jobId);
    jobService.__setToolJobTestRunner('run_project_command', null);
    scheduler.setVerificationMachinePressureForTests(null);
    scheduler.resetSchedulerResourceStateForTests();
    resourceProfiles.clearVerificationResourceProfilesForTests();
  }
});
