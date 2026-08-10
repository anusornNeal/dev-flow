import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-verification-candidate-'));
process.env.DEVFLOW_RUNTIME_DIR = path.join(tempRoot, 'runtime');

const {
  createVerificationCandidate,
  resolveVerificationCandidate,
  releaseVerificationCandidate,
  isVerificationCandidateCurrent,
} = await import('../../src/server/services/verificationCandidateService.js');
const { getRepoRevisionForRoot } = await import('../../src/server/services/repoRevisionService.js');

function normalizedText(filePath: string) {
  return fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n');
}

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return String(result.stdout || '').trim();
}

function fixture(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'tracked-base\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'deleted.txt'), 'delete-me\n', 'utf8');
  git(root, ['init']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  git(root, ['config', 'user.email', 'devflow@example.com']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('verification candidate freezes tracked, untracked, and deleted state while live workspace advances', () => {
  const root = fixture('freeze');
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-a\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'untracked.txt'), 'candidate-a-untracked\n', 'utf8');
  fs.rmSync(path.join(root, 'src', 'deleted.txt'));

  const sourceRevision = getRepoRevisionForRoot(root).token;
  const candidate = createVerificationCandidate(root);
  const publicJson = JSON.stringify(candidate);

  assert.equal(candidate.repoRevision, sourceRevision);
  assert.match(candidate.candidateId, /^vc_[a-f0-9]{24}$/);
  assert.match(candidate.snapshotCommit, /^[a-f0-9]{40}$/);
  assert.doesNotMatch(publicJson, /verification-candidates|[A-Z]:\\|\/tmp\//i);

  const resolved = resolveVerificationCandidate(candidate.candidateId);
  assert.equal(normalizedText(path.join(resolved.root, 'src', 'value.txt')), 'candidate-a\n');
  assert.equal(normalizedText(path.join(resolved.root, 'src', 'untracked.txt')), 'candidate-a-untracked\n');
  assert.equal(fs.existsSync(path.join(resolved.root, 'src', 'deleted.txt')), false);
  assert.equal(isVerificationCandidateCurrent(root, candidate), true);

  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-b\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'untracked.txt'), 'candidate-b-untracked\n', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'new-b.txt'), 'new-b\n', 'utf8');

  assert.equal(isVerificationCandidateCurrent(root, candidate), false);
  assert.equal(normalizedText(path.join(resolved.root, 'src', 'value.txt')), 'candidate-a\n');
  assert.equal(normalizedText(path.join(resolved.root, 'src', 'untracked.txt')), 'candidate-a-untracked\n');
  assert.equal(fs.existsSync(path.join(resolved.root, 'src', 'new-b.txt')), false);

  const snapshotRoot = resolved.root;
  releaseVerificationCandidate(candidate.candidateId);
  assert.equal(fs.existsSync(snapshotRoot), false);
  assert.throws(() => resolveVerificationCandidate(candidate.candidateId), /candidate/i);
});

test('verification candidate snapshots only allowlisted ignored command config files', () => {
  const root = fixture('ignored-command-config');
  fs.writeFileSync(path.join(root, '.gitignore'), '.devflow/\n', 'utf8');
  git(root, ['add', '.gitignore']);
  git(root, ['commit', '-m', 'ignore devflow config']);
  fs.mkdirSync(path.join(root, '.devflow'), { recursive: true });
  const commandConfig = [
    'commands:',
    '  focused:',
    '    executable: node',
    '    args:',
    '      - scripts/test.mjs',
    '    category: test',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, '.devflow', 'commands.yaml'), commandConfig, 'utf8');
  fs.writeFileSync(path.join(root, '.devflow', 'private-state.json'), '{"secret":"must-not-copy"}\n', 'utf8');

  const candidate = createVerificationCandidate(root);
  assert.match(candidate.commandConfigFingerprint || '', /^[a-f0-9]{64}$/);
  try {
    const resolved = resolveVerificationCandidate(candidate.candidateId);
    assert.equal(normalizedText(path.join(resolved.root, '.devflow', 'commands.yaml')), commandConfig);
    assert.equal(fs.existsSync(path.join(resolved.root, '.devflow', 'private-state.json')), false);
    assert.equal(resolved.commandConfigFingerprint, candidate.commandConfigFingerprint);
    assert.equal(isVerificationCandidateCurrent(root, candidate, candidate.commandConfigFingerprint), true);

    fs.appendFileSync(path.join(root, '.devflow', 'commands.yaml'), '# changed\n', 'utf8');
    assert.equal(isVerificationCandidateCurrent(root, candidate, candidate.commandConfigFingerprint), false, 'ignored command config changes must stale repository-config candidate currentness');
  } finally {
    releaseVerificationCandidate(candidate.candidateId);
  }
});

test('verification candidate registry can be resolved from disk and release is idempotent', () => {
  const root = fixture('persisted');
  fs.writeFileSync(path.join(root, 'src', 'value.txt'), 'candidate-a\n', 'utf8');

  const candidate = createVerificationCandidate(root);
  const first = resolveVerificationCandidate(candidate.candidateId);
  const second = resolveVerificationCandidate(candidate.candidateId);
  assert.equal(second.root, first.root);
  assert.equal(second.repoRevision, candidate.repoRevision);
  assert.equal(second.snapshotCommit, candidate.snapshotCommit);

  assert.equal(releaseVerificationCandidate(candidate.candidateId), true);
  assert.equal(releaseVerificationCandidate(candidate.candidateId), false);
});
