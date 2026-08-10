import test from 'node:test';
import assert from 'node:assert/strict';
import * as policyModule from '../../src/server/services/projectGitWorkflowPolicyService.js';
import {
  renderGitWorkflowTemplate,
  resolveProjectGitWorkflowPolicy,
  resolveTaskTicketContext,
  validateGitWorkflowPolicy,
} from '../../src/server/services/projectGitWorkflowPolicyService.js';

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

test('template rendering supports ticket title and type without repo-specific branches', () => {
  const rendered = renderGitWorkflowTemplate('[{ticket}] {type}: {title}', {
    ticket: 'QCA-3617',
    title: 'Fix installer summary',
    type: 'Fix',
  });
  assert.equal(rendered, '[QCA-3617] Fix: Fix installer summary');
  assert.equal(renderGitWorkflowTemplate('Merge {ticket}', { ticket: 'QCA-3617', title: '', type: '' }), 'Merge QCA-3617');
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
