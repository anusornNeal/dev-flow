import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-job-candidate-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const {
  createJob,
  getJob,
  readJobResult,
} = await import('../../src/server/repositories/mcpToolJobRepository.js');
const {
  __setToolJobTestRunner,
  cancelToolJob,
  enqueueToolJob,
  getToolJobStatus,
  initMcpToolJobs,
} = await import('../../src/server/services/mcpToolJobService.js');
const {
  prepareProjectCommandVerificationCandidate,
  runProjectCommand,
} = await import('../../src/server/services/projectCommandService.js');
const {
  resolveVerificationCandidate,
  releaseVerificationCandidate,
} = await import('../../src/server/services/verificationCandidateService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeVerificationRepo(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-a\n', 'utf8');
  fs.writeFileSync(path.join(root, 'scripts', 'read.mjs'), [
    "import fs from 'node:fs';",
    "process.stdout.write(fs.readFileSync('src/value.txt', 'utf8').trim());",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { test: 'node scripts/read.mjs' },
  }, null, 2), 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'candidate a']);
  const projectId = `project-${name}`;
  createProject({ id: projectId, name, repoUrl: `https://example.com/${name}`, localPath: root });
  return { root, projectId };
}

function makeState(root: string, projectId: string): any {
  return {
    projects: [{ id: projectId, name: projectId, repoUrl: `https://example.com/${projectId}`, localPath: root }],
  };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(message);
}

async function waitForStatus(jobId: string, status: string) {
  await waitUntil(() => getToolJobStatus(jobId)?.status === status, `Expected ${jobId} to reach ${status}`);
  return getToolJobStatus(jobId);
}

async function waitForCandidateRelease(candidateId: string) {
  await waitUntil(() => {
    try {
      resolveVerificationCandidate(candidateId);
      return false;
    } catch {
      return true;
    }
  }, `Expected candidate ${candidateId} to be released`);
}

function assertCandidateReleased(candidateId: string) {
  assert.throws(
    () => resolveVerificationCandidate(candidateId),
    /candidate/i,
    `expected candidate ${candidateId} to be released`,
  );
}

test('fresh cached run_project_command completes durable job before candidate creation or process execution', async () => {
  const { root, projectId } = makeVerificationRepo('cache-first');
  const state = makeState(root, projectId);
  const args = {
    localPath: root,
    command: 'test',
    cacheResult: true,
    singleFlight: false,
  };
  const primed = runProjectCommand(state, args);
  assert.equal(primed.ok, true);
  assert.equal(primed.cache?.hit, false);

  const job = enqueueToolJob(state, 'run_project_command', args, 'repo-command');
  assert.equal(job.status, 'succeeded', 'fresh cache hit should be terminal on admission');
  assert.equal(job.queuePosition, 0);
  const persisted = getJob(job.jobId);
  assert.equal(persisted?.args?.__verificationCandidate, undefined, 'cache hit must not create/persist a candidate');
  const result = readJobResult(job.jobId) as any;
  assert.equal(result?.result?.cache?.hit, true);
  assert.equal(result?.result?.processSpawns, 0);
});

test('queued cache miss persists cheap admission identity and defers immutable candidate creation', async () => {
  const { root, projectId } = makeVerificationRepo('deferred-candidate');
  const state = makeState(root, projectId);
  const writeTool = `candidate_defer_write_${randomUUID()}`;
  const blocker = deferred();
  __setToolJobTestRunner(writeTool, async () => {
    await blocker.promise;
    return { ok: true };
  });

  try {
    const write = enqueueToolJob(state, writeTool, { localPath: root }, 'repo-write');
    await waitForStatus(write.jobId, 'running');
    const verify = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'test',
      cacheResult: false,
      forceFresh: true,
      singleFlight: false,
    }, 'repo-command');
    assert.equal(getToolJobStatus(verify.jobId)?.status, 'queued');
    const persisted = getJob(verify.jobId);
    assert.equal(persisted?.args?.__verificationCandidate, undefined, 'queued miss must not pre-create candidate worktree');
    assert.match(String(persisted?.args?.__projectCommandAdmissionIdentity?.key || ''), /^[a-f0-9]{64}$/);
    assert.equal(cancelToolJob(verify.jobId), true);
    assert.equal(getToolJobStatus(verify.jobId)?.status, 'cancelled');
    blocker.resolve();
    await waitForStatus(write.jobId, 'succeeded');
  } finally {
    blocker.resolve();
    __setToolJobTestRunner(writeTool, null);
  }
});

test('queued run_project_command refuses to verify a newer workspace than its captured admission identity', async () => {
  const { root, projectId } = makeVerificationRepo('queued-a-b');
  const state = makeState(root, projectId);
  const writeTool = `candidate_write_${randomUUID()}`;
  const writeBlocker = deferred();
  __setToolJobTestRunner(writeTool, async () => {
    await writeBlocker.promise;
    return { ok: true };
  });

  try {
    const write = enqueueToolJob(state, writeTool, { localPath: root, label: 'write' }, 'repo-write');
    await waitForStatus(write.jobId, 'running');

    const verify = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'test',
      cacheResult: false,
      forceFresh: true,
      singleFlight: false,
    }, 'repo-command');
    assert.equal(getToolJobStatus(verify.jobId)?.status, 'queued');
    const persisted = getJob(verify.jobId);
    assert.equal(persisted?.args?.__verificationCandidate, undefined);
    assert.match(String(persisted?.args?.__projectCommandAdmissionIdentity?.key || ''), /^[a-f0-9]{64}$/);

    fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-b\n', 'utf8');
    writeBlocker.resolve();
    await waitForStatus(write.jobId, 'succeeded');
    await waitForStatus(verify.jobId, 'failed');

    const result = readJobResult(verify.jobId) as any;
    assert.equal(result?.result?.code, 'VERIFICATION_ADMISSION_STALE');
    assert.equal(getJob(verify.jobId)?.args?.__verificationCandidate, undefined, 'stale admission must not persist a newer candidate');
  } finally {
    writeBlocker.resolve();
    __setToolJobTestRunner(writeTool, null);
  }
});

test('cancelling a queued verification never creates an immutable candidate', async () => {
  const { root, projectId } = makeVerificationRepo('queued-cancel');
  const state = makeState(root, projectId);
  const writeTool = `candidate_cancel_write_${randomUUID()}`;
  const writeBlocker = deferred();
  __setToolJobTestRunner(writeTool, async () => {
    await writeBlocker.promise;
    return { ok: true };
  });

  try {
    const write = enqueueToolJob(state, writeTool, { localPath: root, label: 'write' }, 'repo-write');
    await waitForStatus(write.jobId, 'running');
    const verify = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'test',
      singleFlight: false,
    }, 'repo-command');
    assert.equal(getJob(verify.jobId)?.args?.__verificationCandidate, undefined);
    assert.equal(cancelToolJob(verify.jobId), true);
    assert.equal(getToolJobStatus(verify.jobId)?.status, 'cancelled');
    assert.equal(getJob(verify.jobId)?.args?.__verificationCandidate, undefined);

    writeBlocker.resolve();
    await waitForStatus(write.jobId, 'succeeded');
  } finally {
    writeBlocker.resolve();
    __setToolJobTestRunner(writeTool, null);
  }
});

test('active cancellation releases the candidate after the running process exits', async () => {
  const { root, projectId } = makeVerificationRepo('active-cancel');
  fs.writeFileSync(path.join(root, 'scripts', 'read.mjs'), "await new Promise((resolve) => setTimeout(resolve, 5000));\nprocess.stdout.write('late');\n", 'utf8');
  const state = makeState(root, projectId);
  const verify = enqueueToolJob(state, 'run_project_command', {
    localPath: root,
    command: 'test',
    singleFlight: false,
    forceFresh: true,
  }, 'repo-command');
  await waitForStatus(verify.jobId, 'running');
  await waitUntil(() => /^vc_[a-f0-9]{24}$/.test(String(getJob(verify.jobId)?.args?.__verificationCandidate?.candidateId || '')), 'Expected active verification candidate to be persisted');
  const candidateId = String(getJob(verify.jobId)?.args?.__verificationCandidate?.candidateId || '');
  assert.equal(cancelToolJob(verify.jobId), true);
  assert.equal(getToolJobStatus(verify.jobId)?.status, 'cancelled');
  await waitForCandidateRelease(candidateId);
});

test('failed verification result still releases its immutable candidate', async () => {
  const { root, projectId } = makeVerificationRepo('failed-result');
  fs.writeFileSync(path.join(root, 'scripts', 'read.mjs'), "await new Promise((resolve) => setTimeout(resolve, 250));\nprocess.stderr.write('expected failure');\nprocess.exitCode = 2;\n", 'utf8');
  const state = makeState(root, projectId);
  const verify = enqueueToolJob(state, 'run_project_command', {
    localPath: root,
    command: 'test',
    singleFlight: false,
    forceFresh: true,
  }, 'repo-command');
  await waitForStatus(verify.jobId, 'running');
  await waitUntil(() => /^vc_[a-f0-9]{24}$/.test(String(getJob(verify.jobId)?.args?.__verificationCandidate?.candidateId || '')), 'Expected failing verification candidate to be persisted');
  const candidateId = String(getJob(verify.jobId)?.args?.__verificationCandidate?.candidateId || '');
  await waitForStatus(verify.jobId, 'succeeded');
  const result = readJobResult(verify.jobId) as any;
  assert.equal(result?.result?.ok, false);
  assert.equal(result?.result?.exitCode, 2);
  await waitForCandidateRelease(candidateId);
});

test('queued supersession cancels obsolete work before candidate creation while the newest candidate remains runnable', async () => {
  const { root, projectId } = makeVerificationRepo('queued-supersede');
  const state = makeState(root, projectId);
  const writeTool = `candidate_supersede_write_${randomUUID()}`;
  const writeBlocker = deferred();
  __setToolJobTestRunner(writeTool, async () => {
    await writeBlocker.promise;
    return { ok: true };
  });

  try {
    const write = enqueueToolJob(state, writeTool, { localPath: root, label: 'write' }, 'repo-write');
    await waitForStatus(write.jobId, 'running');

    const first = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'test',
      singleFlight: false,
      verificationSeriesKey: 'series-a',
      verificationCandidateKey: 'candidate-a',
    }, 'repo-command');
    assert.equal(getJob(first.jobId)?.args?.__verificationCandidate, undefined);
    assert.equal(getToolJobStatus(first.jobId)?.status, 'queued');

    const second = enqueueToolJob(state, 'run_project_command', {
      localPath: root,
      command: 'test',
      singleFlight: false,
      verificationSeriesKey: 'series-a',
      verificationCandidateKey: 'candidate-b',
    }, 'repo-command');
    assert.equal(getJob(second.jobId)?.args?.__verificationCandidate, undefined);
    assert.equal(getToolJobStatus(first.jobId)?.status, 'cancelled');
    assert.equal(getJob(first.jobId)?.args?.__verificationCandidate, undefined);

    writeBlocker.resolve();
    await waitForStatus(write.jobId, 'succeeded');
    await waitForStatus(second.jobId, 'succeeded');
    const secondCandidateId = String(getJob(second.jobId)?.args?.__verificationCandidate?.candidateId || '');
    assert.match(secondCandidateId, /^vc_[a-f0-9]{24}$/);
    await waitForCandidateRelease(secondCandidateId);
  } finally {
    writeBlocker.resolve();
    __setToolJobTestRunner(writeTool, null);
  }
});

test('startup recovery resumes a persisted queued candidate A without recapturing live workspace B', async () => {
  const { root, projectId } = makeVerificationRepo('queued-recovery');
  const state = makeState(root, projectId);
  const commandArgs = {
    localPath: root,
    command: 'test',
    cacheResult: false,
    forceFresh: true,
    singleFlight: false,
  };
  const candidate = prepareProjectCommandVerificationCandidate(state, commandArgs);
  assert.ok(candidate);
  const jobId = `job-recovery-${randomUUID()}`;
  createJob(jobId, 'run_project_command', {
    ...commandArgs,
    __verificationCandidate: candidate,
  }, `repo:${root}`);

  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-b\n', 'utf8');
  const persistedCandidate = getJob(jobId)?.args?.__verificationCandidate;
  assert.deepEqual(persistedCandidate, candidate, `persisted candidate changed: ${JSON.stringify({ candidate, persistedCandidate })}`);

  const summary = initMcpToolJobs(state);
  assert.equal(summary.resumable >= 1, true);
  await waitUntil(() => {
    const status = getToolJobStatus(jobId)?.status;
    return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
  }, `Expected ${jobId} to reach a terminal state`);
  const terminal = getToolJobStatus(jobId);
  assert.equal(terminal?.status, 'succeeded', JSON.stringify({ status: terminal?.status, lastLog: terminal?.lastLog, failureSummary: terminal?.failureSummary }));

  const result = readJobResult(jobId) as any;
  assert.equal(result?.result?.stdout?.trim(), 'candidate-a');
  assert.equal(result?.result?.verificationCandidate?.candidateId, candidate?.candidateId);
  assert.equal(result?.result?.verificationCandidate?.current, false);
  await waitForCandidateRelease(candidate!.candidateId);
});
