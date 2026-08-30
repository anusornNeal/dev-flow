import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-mcp-job-freshness-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.sqlite');
process.env.DEVFLOW_JOBS_DIR = path.join(tempRoot, 'jobs');
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { default: db } = await import('../../src/db/index.js');
const { getRepoRevisionForRoot } = await import('../../src/server/services/repoRevisionService.js');
const { readJobResult } = await import('../../src/server/repositories/mcpToolJobRepository.js');
const {
  __setToolJobTestRunner,
  __autonomousTailConfigForTests,
  enqueueToolJob,
  getToolJobStatus,
} = await import('../../src/server/services/mcpToolJobService.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}

function makeRepo(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    type: 'module',
    scripts: { typecheck: 'node -e "process.exit(0)"' },
  }, null, 2));
  fs.writeFileSync(path.join(root, 'value.txt'), 'generation-a\n');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

function stateFor(root: string) {
  return { projects: [{ id: `project-${path.basename(root)}`, name: path.basename(root), localPath: root }] } as any;
}

function candidate(root: string, key: string) {
  return {
    candidateId: `vc_${key.slice(0, 24)}`,
    repoRevision: getRepoRevisionForRoot(root).token,
    snapshotCommit: '0'.repeat(40),
    createdAt: new Date().toISOString(),
    executionIdentity: { key },
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

async function waitForTerminal(jobId: string) {
  await waitUntil(() => {
    const status = getToolJobStatus(jobId)?.status;
    return status === 'succeeded' || status === 'failed' || status === 'timed_out' || status === 'cancelled';
  }, `Expected ${jobId} to become terminal`);
  return getToolJobStatus(jobId)!;
}

after(() => {
  __setToolJobTestRunner('run_project_command', null);
  try { db.close(); } catch {}
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
});

test('autonomous tail config uses explicit commit intent without requiring the legacy enabled flag', () => {
  assert.deepEqual(__autonomousTailConfigForTests({ args: { autonomousTail: { commitMessage: 'fix: close verified task' } } } as any), {
    commitMessage: 'fix: close verified task',
  });
  assert.equal(__autonomousTailConfigForTests({ args: { autonomousTail: {} } } as any), null);
});

test('current same-candidate GREEN result is explicitly authoritative and current', async () => {
  const root = makeRepo('current');
  const state = stateFor(root);
  __setToolJobTestRunner('run_project_command', async () => ({ ok: true, proof: 'current-green' }));

  const job = enqueueToolJob(state, 'run_project_command', {
    localPath: root,
    command: 'typecheck',
    singleFlight: false,
    verificationSeriesKey: 'freshness-current',
    verificationCandidateKey: 'rev-1',
    verificationGeneration: 1,
    verificationEvidenceIntent: 'green',
    __verificationCandidate: candidate(root, '1'.repeat(64)),
  }, 'repo-command');

  const status: any = await waitForTerminal(job.jobId);
  assert.equal(status.status, 'succeeded');
  assert.equal(status.verificationFreshness, 'current');
  assert.equal(status.authoritative, true);
  assert.equal(status.stale, false);
  assert.equal(status.superseded, false);
  assert.equal((readJobResult(job.jobId) as any)?.result?.proof, 'current-green');
});

test('GREEN becomes stale when repository revision mutates while its candidate is running', async () => {
  const root = makeRepo('repo-mutation');
  const state = stateFor(root);
  const gate = deferred();
  __setToolJobTestRunner('run_project_command', async () => {
    await gate.promise;
    return { ok: true, proof: 'must-not-be-authoritative' };
  });

  const job = enqueueToolJob(state, 'run_project_command', {
    localPath: root,
    command: 'typecheck',
    singleFlight: false,
    verificationSeriesKey: 'freshness-mutation',
    verificationCandidateKey: 'rev-1',
    verificationGeneration: 1,
    verificationEvidenceIntent: 'green',
    __verificationCandidate: candidate(root, '2'.repeat(64)),
  }, 'repo-command');

  await waitUntil(() => getToolJobStatus(job.jobId)?.status === 'running', 'Expected GREEN to start');
  fs.writeFileSync(path.join(root, 'value.txt'), 'generation-b\n');
  gate.resolve();

  const status: any = await waitForTerminal(job.jobId);
  const result = (readJobResult(job.jobId) as any)?.result;
  assert.equal(status.status, 'cancelled');
  assert.equal(status.verificationFreshness, 'stale');
  assert.equal(status.authoritative, false);
  assert.equal(status.stale, true);
  assert.equal(status.superseded, false);
  assert.equal(result?.code, 'VERIFICATION_RESULT_STALE');
  assert.equal(result?.authoritative, false);
  assert.equal(result?.stale, true);
  assert.equal(result?.verificationFreshness, 'stale');
  assert.notEqual(result?.proof, 'must-not-be-authoritative');
});

test('late GREEN from an older generation is fenced after a newer generation exists', async () => {
  const root = makeRepo('generation-fence');
  const state = stateFor(root);
  const oldGate = deferred();
  __setToolJobTestRunner('run_project_command', async (_state, args) => {
    if (args.verificationGeneration === 1) await oldGate.promise;
    return { ok: true, generation: args.verificationGeneration };
  });

  const oldArgs = {
    localPath: root,
    command: 'typecheck',
    verificationSeriesKey: 'freshness-generation',
    verificationCandidateKey: 'rev-1',
    verificationGeneration: 1,
    verificationEvidenceIntent: 'green',
    __verificationCandidate: candidate(root, '3'.repeat(64)),
  };
  const oldLeader = enqueueToolJob(state, 'run_project_command', oldArgs, 'repo-command');
  await waitUntil(() => getToolJobStatus(oldLeader.jobId)?.status === 'running', 'Expected old GREEN leader to start');

  const oldFollower = enqueueToolJob(state, 'run_project_command', oldArgs, 'repo-command');
  assert.equal(oldFollower.sharedWith, oldLeader.jobId, 'single-flight follower should protect the running leader from eager supersession');

  const newer = enqueueToolJob(state, 'run_project_command', {
    ...oldArgs,
    singleFlight: false,
    verificationCandidateKey: 'rev-2',
    verificationGeneration: 2,
    __verificationCandidate: candidate(root, '4'.repeat(64)),
  }, 'repo-command');
  const newerStatus: any = await waitForTerminal(newer.jobId);
  assert.equal(newerStatus.status, 'succeeded');

  oldGate.resolve();
  const oldStatus: any = await waitForTerminal(oldLeader.jobId);
  const followerStatus: any = await waitForTerminal(oldFollower.jobId);
  const oldResult = (readJobResult(oldLeader.jobId) as any)?.result;

  assert.equal(oldStatus.status, 'cancelled');
  assert.equal(oldStatus.superseded, true);
  assert.equal(oldStatus.authoritative, false);
  assert.equal(oldStatus.verificationFreshness, 'superseded');
  assert.equal(oldStatus.supersededByCandidateKey, 'rev-2');
  assert.equal(oldStatus.supersededByGeneration, 2);
  assert.equal(oldResult?.code, 'JOB_SUPERSEDED');
  assert.equal(oldResult?.authoritative, false);
  assert.equal(followerStatus.status, 'cancelled');
  assert.equal((readJobResult(oldFollower.jobId) as any)?.result?.code, 'JOB_SUPERSEDED');
});
