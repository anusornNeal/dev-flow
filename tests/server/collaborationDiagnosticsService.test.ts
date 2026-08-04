import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-collaboration-'));
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'devflow.db');

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { getChangeSummary } = await import('../../src/server/services/gitService.js');
const { createPullRequest } = await import('../../src/server/services/githubPullRequestService.js');
const { getCapabilityCatalog, getToolSchema } = await import('../../src/server/contracts/devflowContract.js');

function git(root: string, args: string[]) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || `git ${args.join(' ')} failed`);
  return (result.stdout || '').trim();
}

function createRepository(name: string) {
  const root = path.join(tempRoot, name);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, ['init', '-b', 'develop']);
  git(root, ['config', 'user.email', 'devflow@example.test']);
  git(root, ['config', 'user.name', 'DevFlow Test']);
  fs.writeFileSync(path.join(root, 'src', 'modify.txt'), 'one\n');
  fs.writeFileSync(path.join(root, 'delete.txt'), 'delete\n');
  fs.writeFileSync(path.join(root, 'rename-old.txt'), 'rename\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'initial']);
  return root;
}

test('getChangeSummary expands tracked and untracked files with line and directory totals', () => {
  const root = createRepository('change-summary');
  fs.appendFileSync(path.join(root, 'src', 'modify.txt'), 'two\n');
  fs.rmSync(path.join(root, 'delete.txt'));
  git(root, ['mv', 'rename-old.txt', 'docs/rename-new.txt']);
  fs.mkdirSync(path.join(root, 'skills', 'new'), { recursive: true });
  fs.writeFileSync(path.join(root, 'skills', 'new', 'added.txt'), 'alpha\nbeta\n');

  const result = getChangeSummary({} as any, { localPath: root });

  assert.equal(result.expandedFileCount, 4);
  assert.equal(result.modified, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.renamed, 1);
  assert.equal(result.untracked, 1);
  assert.equal(result.linesAdded, 3);
  assert.equal(result.linesDeleted, 1);
  assert.equal(result.files.some((entry: any) => entry.path === 'skills/new/added.txt'), true);
  assert.equal(result.files.some((entry: any) => entry.from === 'rename-old.txt' && entry.path === 'docs/rename-new.txt'), true);
  assert.equal(result.topDirectories.src, 1);
  assert.equal(result.topDirectories.docs, 1);
  assert.equal(result.topDirectories.skills, 1);
});

test('getToolSchema returns only one exact serializable tool definition', () => {
  const schema = getToolSchema('get_git_status');

  assert.equal(schema.name, 'get_git_status');
  assert.equal(typeof schema.description, 'string');
  assert.ok(schema.inputSchema);
  assert.equal('buildHttpRequest' in schema, false);
  assert.equal('tools' in schema, false);
  assert.throws(
    () => getToolSchema('missing_tool'),
    (error: any) => error?.payload?.code === 'TOOL_NOT_FOUND',
  );
});

test('capability catalog exposes an end-to-end workflow matrix', () => {
  const catalog = getCapabilityCatalog() as any;

  assert.equal(catalog.matrix.git.ensureBranch, true);
  assert.equal(catalog.matrix.git.push, true);
  assert.equal(catalog.matrix.git.syncStatus, true);
  assert.equal(catalog.matrix.git.changeSummary, true);
  assert.equal(catalog.matrix.files.delete, true);
  assert.equal(catalog.matrix.files.move, true);
  assert.equal(catalog.matrix.commands.repositoryPresets, true);
  assert.equal(catalog.matrix.tasks.reviewGate, true);
  assert.equal(catalog.matrix.collaboration.createPullRequest, true);
  assert.equal(catalog.workflow.ready, true);
  assert.deepEqual(catalog.workflow.missingSteps, []);
});

function createPullRequestDeps(overrides: Record<string, any> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      number: 42,
      html_url: 'https://github.com/acme/widgets/pull/42',
      state: 'open',
      draft: true,
      head: { ref: 'feature/widgets' },
      base: { ref: 'main' },
    }), { status: 201, headers: { 'Content-Type': 'application/json' } });
  };
  return {
    calls,
    deps: {
      fetchImpl,
      getProject: () => ({ id: 'project-pr', repoUrl: 'git@github.com:acme/widgets.git', localPath: '/tmp/widgets' }),
      getTask: () => ({
        id: 'task-pr',
        displayId: 'DVF-0999',
        title: 'Add widget delivery',
        description: 'Deliver widgets safely.',
        acceptanceCriteria: '- Widget flow works.\n- Existing flow remains unchanged.',
        verificationEvidence: [{ name: 'tests', command: 'npm test', status: 'passed', summary: '20 tests passed' }],
      }),
      getSettings: () => ({ githubToken: 'secret-token' }),
      getSyncStatus: () => ({
        branch: 'feature/widgets',
        trackingBranch: 'origin/feature/widgets',
        localHead: 'abc123',
        remoteHead: 'abc123',
        ahead: 0,
        behind: 0,
        diverged: false,
        pushed: true,
        workingTreeClean: true,
      }),
      getChangeSummary: () => ({ expandedFileCount: 3, added: 1, modified: 2, deleted: 0, renamed: 0, linesAdded: 20, linesDeleted: 4 }),
      getGitLog: () => ({ commits: [{ hash: 'abc123', message: 'feat: widgets' }] }),
      ...overrides,
    },
  };
}

test('createPullRequest dry-run builds a task-derived preview without a remote mutation', async () => {
  const fixture = createPullRequestDeps();

  const result = await createPullRequest({} as any, {
    projectId: 'project-pr',
    taskId: 'DVF-0999',
    base: 'main',
    bodyFromTask: true,
    draft: true,
    dryRun: true,
  }, fixture.deps as any);

  assert.equal(result.dryRun, true);
  assert.equal(result.created, false);
  assert.equal(result.head, 'feature/widgets');
  assert.equal(result.base, 'main');
  assert.match(result.body, /Acceptance criteria/);
  assert.match(result.body, /20 tests passed/);
  assert.match(result.body, /abc123/);
  assert.equal(fixture.calls.length, 0);
});

test('createPullRequest creates a GitHub PR with external credentials and never merges', async () => {
  const fixture = createPullRequestDeps();

  const result = await createPullRequest({} as any, {
    projectId: 'project-pr',
    taskId: 'DVF-0999',
    base: 'main',
    bodyFromTask: true,
    draft: true,
  }, fixture.deps as any);

  assert.equal(result.created, true);
  assert.equal(result.number, 42);
  assert.equal(result.url, 'https://github.com/acme/widgets/pull/42');
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].url, 'https://api.github.com/repos/acme/widgets/pulls');
  const requestBody = JSON.parse(String(fixture.calls[0].init?.body));
  assert.deepEqual(Object.keys(requestBody).sort(), ['base', 'body', 'draft', 'head', 'title']);
  assert.equal(requestBody.merge, undefined);
  assert.match(String((fixture.calls[0].init?.headers as any)?.Authorization), /^Bearer /);
});

test('createPullRequest blocks missing credentials and unpublished branches with actionable errors', async () => {
  const noToken = createPullRequestDeps({ getSettings: () => ({}) });
  await assert.rejects(
    () => createPullRequest({} as any, { projectId: 'project-pr', base: 'main' }, noToken.deps as any),
    (error: any) => error?.payload?.code === 'GITHUB_TOKEN_MISSING' && /settings|environment/i.test(error?.payload?.message || ''),
  );

  const unpublished = createPullRequestDeps({
    getSyncStatus: () => ({
      branch: 'feature/widgets',
      trackingBranch: 'origin/feature/widgets',
      localHead: 'abc123',
      remoteHead: 'def456',
      ahead: 1,
      behind: 0,
      diverged: false,
      pushed: false,
      workingTreeClean: true,
    }),
  });
  await assert.rejects(
    () => createPullRequest({} as any, { projectId: 'project-pr', base: 'main', dryRun: true }, unpublished.deps as any),
    (error: any) => error?.payload?.code === 'PULL_REQUEST_HEAD_NOT_PUBLISHED',
  );
});
