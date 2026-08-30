import { after, test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-admission-telemetry-'));
const previous = {
  dbPath: process.env.DEVFLOW_DB_PATH,
  jobsDir: process.env.DEVFLOW_JOBS_DIR,
  runtimeDir: process.env.DEVFLOW_RUNTIME_DIR,
};
process.env.DEVFLOW_DB_PATH = path.join(root, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(root, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(root, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
const { default: db } = await import('../../src/db/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  __setToolJobTestRunner,
  __resetQueueWaitTelemetryForTests,
  enqueueToolJob,
  getQueueMetrics,
  getToolJobStatus,
} = await import('../../src/server/services/mcpToolJobService.js');

const projectRoot = fs.mkdtempSync(path.join(root, 'repo-'));
createProject({ id: 'project-admission-telemetry', name: 'admission-telemetry', localPath: projectRoot });
const state: any = { projects: [{ id: 'project-admission-telemetry', name: 'admission-telemetry', localPath: projectRoot }] };

function restore(name: 'DEVFLOW_DB_PATH' | 'DEVFLOW_JOBS_DIR' | 'DEVFLOW_RUNTIME_DIR', value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

after(() => {
  __setToolJobTestRunner('search_local_files', null);
  try { db.close(); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  restore('DEVFLOW_DB_PATH', previous.dbPath);
  restore('DEVFLOW_JOBS_DIR', previous.jobsDir);
  restore('DEVFLOW_RUNTIME_DIR', previous.runtimeDir);
});

test('search admission telemetry attributes resource, policy, and durable persistence phases', async () => {
  __resetQueueWaitTelemetryForTests();
  __setToolJobTestRunner('search_local_files', async () => ({ ok: true, count: 0, matches: [] }));

  const accepted = enqueueToolJob(state, 'search_local_files', {
    projectId: 'project-admission-telemetry',
    query: 'needle',
    singleFlight: false,
  }, 'repo-read');

  await new Promise(resolve => setTimeout(resolve, 25));
  const status: any = getToolJobStatus(accepted.jobId);
  assert.ok(status);
  assert.equal(typeof status.phaseTimings.admissionWaitMs, 'number');
  assert.equal(typeof status.phaseTimings.admissionResourceMs, 'number');
  assert.equal(typeof status.phaseTimings.admissionPolicyMs, 'number');
  assert.equal(typeof status.phaseTimings.admissionPersistenceMs, 'number');
  assert.equal(
    status.phaseTimings.admissionResourceMs + status.phaseTimings.admissionPolicyMs + status.phaseTimings.admissionPersistenceMs <= status.phaseTimings.admissionWaitMs,
    true,
  );

  const phases: any = getQueueMetrics().metrics.phaseTelemetry.byTool.search_local_files;
  assert.ok(phases);
  assert.equal(phases.admissionResource.count >= 1, true);
  assert.equal(phases.admissionPolicy.count >= 1, true);
  assert.equal(phases.admissionPersistence.count >= 1, true);
});
