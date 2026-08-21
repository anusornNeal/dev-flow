import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as policyModule from '../../src/server/services/projectGitWorkflowPolicyService.js';
import {
  renderGitWorkflowTemplate,
  resolveProjectGitWorkflowPolicy,
  resolveTaskTicketContext,
  taskCommitSubjectMatchesPolicy,
  validateGitWorkflowPolicy,
} from '../../src/server/services/projectGitWorkflowPolicyService.js';

function createRepoPolicyRoot(policy: unknown) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-policy-'));
  const devflowDir = path.join(root, '.devflow');
  fs.mkdirSync(devflowDir, { recursive: true });
  fs.writeFileSync(path.join(devflowDir, 'project.json'), JSON.stringify(policy, null, 2), 'utf8');
  return root;
}

test('projects without policy inherit rebase-ff with independent message defaults', () => {
  const policy = resolveProjectGitWorkflowPolicy({ id: 'p1' } as any);
  assert.equal(policy.integrationStrategy, 'rebase-ff');
  assert.equal(policy.commitMessageTemplate, '[{ticket}] {type}: {title}');
  assert.equal(policy.mergeMessageTemplate, 'Merge {ticket}');
});

test('explicit merge policy does not force a commit-message convention', () => {
  const policy = resolveProjectGitWorkflowPolicy({
    id: 'p2',
    gitWorkflowPolicy: {
      integrationStrategy: 'merge',
      commitMessageTemplate: '[{ticket}] {type}: {title}',
      mergeMessageTemplate: 'Merge {ticket}',
    },
  } as any);
  assert.equal(policy.integrationStrategy, 'merge');
  assert.equal(policy.commitMessageTemplate, '[{ticket}] {type}: {title}');
  assert.equal(policy.mergeMessageTemplate, 'Merge {ticket}');
});

test('ticket context prefers jiraKey and falls back to displayId', () => {
  assert.deepEqual(resolveTaskTicketContext({ jiraKey: 'QCA-3617', displayId: 'DVF-0453', title: 'Policy', category: 'backend' } as any), {
    ticket: 'QCA-3617',
    title: 'Policy',
    type: 'backend',
  });
  assert.equal(resolveTaskTicketContext({ displayId: 'DVF-0453', title: 'Policy' } as any).ticket, 'DVF-0453');
});

test('task commit messages use the authoritative card id and normalize conventional scopes', () => {
  const renderTaskCommitMessage = (policyModule as any).renderTaskCommitMessage;
  assert.equal(typeof renderTaskCommitMessage, 'function');
  assert.equal(
    renderTaskCommitMessage('perf(verify): learn command resource profiles', { displayId: 'DVF-0473' } as any),
    '[DVF-0473] perf: learn command resource profiles',
  );
  assert.equal(
    renderTaskCommitMessage('[WRONG-1] FIX(mcp)!: restore request streaming', { jiraKey: 'QCA-3617', displayId: 'DVF-0453' } as any),
    '[QCA-3617] fix: restore request streaming',
  );
});

test('task commit messages preserve explicit project template overrides', () => {
  const renderTaskCommitMessage = (policyModule as any).renderTaskCommitMessage;
  assert.equal(typeof renderTaskCommitMessage, 'function');
  assert.equal(
    renderTaskCommitMessage('perf(cache): reuse evidence', { displayId: 'DVF-0471' } as any, {
      gitWorkflowPolicy: { commitMessageTemplate: '{type}: {title}' },
    } as any),
    'perf: reuse evidence',
  );
});

test('task commit subject policy matcher honors Jira ticket context and custom templates', () => {
  assert.equal(
    taskCommitSubjectMatchesPolicy('[QCA-3617] fix: restore request streaming', { jiraKey: 'QCA-3617', displayId: 'CARD-0453' } as any),
    true,
  );
  assert.equal(
    taskCommitSubjectMatchesPolicy('[CARD-0453] fix: restore request streaming', { jiraKey: 'QCA-3617', displayId: 'CARD-0453' } as any),
    false,
  );
  assert.equal(
    taskCommitSubjectMatchesPolicy('QCA-3617::perf::reuse evidence', { jiraKey: 'QCA-3617' } as any, {
      gitWorkflowPolicy: { commitMessageTemplate: '{ticket}::{type}::{title}' },
    } as any),
    true,
  );
  assert.equal(taskCommitSubjectMatchesPolicy('[CARD-1] feat(scope): bypass', { displayId: 'CARD-1' } as any), false);
});

test('template rendering supports ticket title and type without repo-specific branches', () => {
  const rendered = renderGitWorkflowTemplate('[{ticket}] {type}: {title}', {
    ticket: 'QCA-3617',
    title: 'Fix installer summary',
    type: 'Fix',
  });
  assert.equal(rendered, '[QCA-3617] Fix: Fix installer summary');
  assert.equal(renderGitWorkflowTemplate('Merge {ticket}', { ticket: 'QCA-3617', title: '', type: '' }), 'Merge QCA-3617');
});

test('repository project policy overrides conflicting SQLite workflow policy', () => {
  const root = createRepoPolicyRoot({
    version: 1,
    gitWorkflowPolicy: {
      integrationStrategy: 'rebase-ff',
      commitMessageTemplate: 'repo::{ticket}::{type}::{title}',
      mergeMessageTemplate: 'Repo merge {ticket}',
    },
  });
  const policy = resolveProjectGitWorkflowPolicy({
    id: 'repo-wins',
    gitWorkflowPolicy: { integrationStrategy: 'merge', commitMessageTemplate: 'db::{ticket}', mergeMessageTemplate: 'DB {ticket}' },
  } as any, { repositoryRoot: root } as any);
  assert.deepEqual(policy, {
    integrationStrategy: 'rebase-ff',
    commitMessageTemplate: 'repo::{ticket}::{type}::{title}',
    mergeMessageTemplate: 'Repo merge {ticket}',
  });
});

test('missing repository policy preserves SQLite fallback behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-policy-absent-'));
  const policy = resolveProjectGitWorkflowPolicy({
    id: 'legacy-db',
    gitWorkflowPolicy: { integrationStrategy: 'merge', commitMessageTemplate: '{ticket}: {title}' },
  } as any, { repositoryRoot: root } as any);
  assert.equal(policy.integrationStrategy, 'merge');
  assert.equal(policy.commitMessageTemplate, '{ticket}: {title}');
});

test('existing invalid repository policy fails closed instead of falling back to SQLite', () => {
  const malformedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-policy-invalid-'));
  fs.mkdirSync(path.join(malformedRoot, '.devflow'), { recursive: true });
  fs.writeFileSync(path.join(malformedRoot, '.devflow', 'project.json'), '{ bad json', 'utf8');
  assert.throws(
    () => resolveProjectGitWorkflowPolicy({ id: 'invalid', gitWorkflowPolicy: { integrationStrategy: 'merge' } } as any, { repositoryRoot: malformedRoot } as any),
    (error: any) => error?.payload?.code === 'REPOSITORY_PROJECT_POLICY_INVALID',
  );

  const unknownRoot = createRepoPolicyRoot({ version: 1, gitWorkflowPolicy: {}, runtimeState: { unsafe: true } });
  assert.throws(
    () => resolveProjectGitWorkflowPolicy({ id: 'unknown-field' } as any, { repositoryRoot: unknownRoot } as any),
    (error: any) => error?.payload?.code === 'REPOSITORY_PROJECT_POLICY_INVALID' && /runtimeState/.test(error.message),
  );
});

test('repository policy is root-isolated and refreshed without restart', () => {
  const rootA = createRepoPolicyRoot({ version: 1, gitWorkflowPolicy: { integrationStrategy: 'rebase-ff' } });
  const rootB = createRepoPolicyRoot({ version: 1, gitWorkflowPolicy: { integrationStrategy: 'merge' } });
  assert.equal(resolveProjectGitWorkflowPolicy({ id: 'a' } as any, { repositoryRoot: rootA } as any).integrationStrategy, 'rebase-ff');
  assert.equal(resolveProjectGitWorkflowPolicy({ id: 'b' } as any, { repositoryRoot: rootB } as any).integrationStrategy, 'merge');

  fs.writeFileSync(path.join(rootA, '.devflow', 'project.json'), JSON.stringify({ version: 1, gitWorkflowPolicy: { integrationStrategy: 'merge' } }), 'utf8');
  assert.equal(resolveProjectGitWorkflowPolicy({ id: 'a' } as any, { repositoryRoot: rootA } as any).integrationStrategy, 'merge');
});

test('repository policy rejects symlink and oversized files', () => {
  const targetRoot = createRepoPolicyRoot({ version: 1, gitWorkflowPolicy: { integrationStrategy: 'merge' } });
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-repo-policy-symlink-'));
  fs.mkdirSync(path.join(symlinkRoot, '.devflow'), { recursive: true });
  const linkPath = path.join(symlinkRoot, '.devflow', 'project.json');
  try {
    fs.symlinkSync(path.join(targetRoot, '.devflow', 'project.json'), linkPath);
    assert.throws(
      () => resolveProjectGitWorkflowPolicy({ id: 'symlink' } as any, { repositoryRoot: symlinkRoot } as any),
      (error: any) => error?.payload?.code === 'REPOSITORY_PROJECT_POLICY_INVALID',
    );
  } catch (error: any) {
    if (error?.code !== 'EPERM' && error?.code !== 'EACCES') throw error;
  }

  const oversizedRoot = createRepoPolicyRoot({ version: 1, gitWorkflowPolicy: {} });
  fs.writeFileSync(path.join(oversizedRoot, '.devflow', 'project.json'), ' '.repeat(100_001), 'utf8');
  assert.throws(
    () => resolveProjectGitWorkflowPolicy({ id: 'oversized' } as any, { repositoryRoot: oversizedRoot } as any),
    (error: any) => error?.payload?.code === 'REPOSITORY_PROJECT_POLICY_TOO_LARGE',
  );
});

test('invalid integration strategies and placeholders fail with actionable policy errors', () => {
  assert.throws(
    () => validateGitWorkflowPolicy({ integrationStrategy: 'squash' } as any),
    (error: any) => error?.payload?.code === 'PROJECT_GIT_POLICY_INVALID' && /integrationStrategy/.test(error.message),
  );
  assert.throws(
    () => validateGitWorkflowPolicy({ commitMessageTemplate: '{repoName}: {title}' } as any),
    (error: any) => error?.payload?.code === 'PROJECT_GIT_POLICY_INVALID' && /repoName/.test(error.message),
  );
  assert.throws(
    () => renderGitWorkflowTemplate('[{ticket}] {title}', { ticket: '', title: 'Missing key', type: 'Fix' }),
    (error: any) => error?.payload?.code === 'GIT_WORKFLOW_TEMPLATE_VALUE_REQUIRED' && /ticket/.test(error.message),
  );
});
