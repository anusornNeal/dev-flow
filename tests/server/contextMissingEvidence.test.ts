import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-missing-context-'));
process.env.DEVFLOW_DB_PATH = path.join(os.tmpdir(), `devflow-missing-context-db-${path.basename(tempDir)}.sqlite`);
fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
fs.mkdirSync(path.join(tempDir, 'tests'), { recursive: true });
const filler = Array.from({ length: 105 }, (_, index) => `export const filler${index} = ${index};`);
fs.writeFileSync(path.join(tempDir, 'src', 'Example.ts'), [
  'export function Example() { return 1; }',
  ...filler,
  'export function DeepHelper() { return 42; }',
  'export function Tail() { return DeepHelper(); }',
].join('\n'), 'utf8');
fs.writeFileSync(path.join(tempDir, 'tests', 'Example.test.ts'), "import { DeepHelper } from '../src/Example';\nexport const expected = DeepHelper();\n", 'utf8');

function git(args: string[]) {
  const result = spawnSync('git', args, { cwd: tempDir, encoding: 'utf8', shell: false });
  assert.equal(result.status, 0, result.stderr || result.stdout || `git ${args.join(' ')} failed`);
}
git(['init']);
git(['config', 'user.name', 'DevFlow Test']);
git(['config', 'user.email', 'devflow@example.com']);
git(['add', '.']);
git(['commit', '-m', 'initial']);

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
createProject({ id: 'project-missing-context', name: 'Missing Context Fixture', repoUrl: 'https://example.com/missing-context', localPath: tempDir });
const { clearContextHandles, getRepoContextWithHandle } = await import('../../src/server/services/contextHandleService.js');
const { normalizeMissingContextRequest } = await import('../../src/server/services/projectStartContextService.js');
const { stopAllRepoChangeWatchers } = await import('../../src/server/services/workspaceChangeWatcherService.js');

const state: any = {
  projectsCache: [
    { id: 'project-missing-context', name: 'Missing Context Fixture', repoUrl: 'https://example.com/missing-context', localPath: tempDir },
  ],
};
const baseArgs = { projectId: 'project-missing-context', q: 'fix Example function bug', intent: 'small-bug' };

function byteSize(value: unknown) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

test.beforeEach(() => clearContextHandles());

test('missing-context request normalization caps categories and total evidence items', () => {
  const values = Array.from({ length: 12 }, (_, index) => `item-${index}`);
  const request = normalizeMissingContextRequest({
    contextSufficient: false,
    missingFiles: values,
    missingSymbols: values,
    missingTests: values,
    missingRelationships: values,
  });
  assert.equal(request.files.length, 8);
  assert.equal(request.symbols.length, 8);
  assert.equal(request.tests.length, 8);
  assert.equal(request.relationships.length, 0);
  assert.equal(request.total, 24);
});

test('valid handle suppresses unchanged context and narrowly recovers a missing deep symbol', () => {
  const initial: any = getRepoContextWithHandle(state, baseArgs);
  assert.equal(initial.status, 'full');
  assert.ok(initial.bundle?.snippets.length >= 1);
  const sourceInitial = initial.bundle.snippets.find((entry: any) => entry.path.replace(/\\/g, '/') === 'src/Example.ts');
  assert.ok(sourceInitial);
  assert.doesNotMatch(sourceInitial.content, /DeepHelper/);

  const unchanged: any = getRepoContextWithHandle(state, { ...baseArgs, contextHandle: initial.contextHandle });
  assert.equal(unchanged.status, 'not_modified');
  assert.equal(unchanged.changedSnippets.length, 0);
  assert.ok(byteSize(unchanged) < byteSize(initial));

  const recovered: any = getRepoContextWithHandle(state, {
    ...baseArgs,
    contextHandle: initial.contextHandle,
    contextSufficient: false,
    missingSymbols: ['DeepHelper'],
  });
  assert.equal(recovered.status, 'delta');
  assert.equal(recovered.reason, 'missing-context');
  assert.equal(recovered.missingContext.status, 'resolved');
  assert.equal(recovered.missingContext.request.symbols[0], 'DeepHelper');
  assert.equal(recovered.changedSnippets.length, 1);
  assert.match(recovered.changedSnippets[0].content, /DeepHelper/);
  assert.match(recovered.changedSnippets[0].evidenceKey, /^symbol:DeepHelper:/);
  assert.equal(typeof recovered.changedSnippets[0].revision, 'string');
  assert.ok(recovered.metrics.returnedBytes < byteSize(initial));
  assert.equal(recovered.metrics.followUpCalls, 1);
  assert.equal(recovered.metrics.recoverySuccess, true);
});

test('repeated missing-evidence request does not resend unchanged known evidence', () => {
  const initial: any = getRepoContextWithHandle(state, baseArgs);
  const request = {
    ...baseArgs,
    contextHandle: initial.contextHandle,
    contextSufficient: false,
    missingSymbols: 'DeepHelper',
  };
  const first: any = getRepoContextWithHandle(state, request);
  assert.equal(first.status, 'delta');
  const second: any = getRepoContextWithHandle(state, request);
  assert.equal(second.status, 'not_modified');
  assert.equal(second.reason, 'missing-context');
  assert.equal(second.changedSnippets.length, 0);
  assert.equal(second.metrics.knownEvidenceSkipped, 1);
  assert.ok(byteSize(second) < byteSize(first));
});

test('revision change refreshes only the requested known evidence', () => {
  const initial: any = getRepoContextWithHandle(state, baseArgs);
  const request = {
    ...baseArgs,
    contextHandle: initial.contextHandle,
    contextSufficient: false,
    missingSymbols: ['DeepHelper'],
  };
  const first: any = getRepoContextWithHandle(state, request);
  const filePath = path.join(tempDir, 'src', 'Example.ts');
  fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('return 42;', 'return 43;'), 'utf8');

  const refreshed: any = getRepoContextWithHandle(state, request);
  assert.equal(refreshed.status, 'delta');
  assert.equal(refreshed.changedSnippets.length, 1);
  assert.match(refreshed.changedSnippets[0].content, /return 43/);
  assert.notEqual(refreshed.changedSnippets[0].revision, first.changedSnippets[0].revision);

  const normalDelta: any = getRepoContextWithHandle(state, { ...baseArgs, contextHandle: initial.contextHandle });
  assert.equal(normalDelta.status, 'delta');
  assert.ok(normalDelta.changedSnippets.some((entry: any) => entry.path.replace(/\\/g, '/') === 'src/Example.ts'));
});

test('specific missing file/test evidence is bounded and empty requests never broaden automatically', () => {
  const initial: any = getRepoContextWithHandle(state, baseArgs);
  const empty: any = getRepoContextWithHandle(state, {
    ...baseArgs,
    contextHandle: initial.contextHandle,
    contextSufficient: false,
  });
  assert.equal(empty.status, 'not_modified');
  assert.equal(empty.reason, 'missing-context');
  assert.equal(empty.missingContext.status, 'specific-evidence-required');
  assert.equal(empty.changedSnippets.length, 0);

  const targeted: any = getRepoContextWithHandle(state, {
    ...baseArgs,
    contextHandle: initial.contextHandle,
    contextSufficient: false,
    missingFiles: ['src/Example.ts'],
    missingTests: ['tests/Example.test.ts'],
  });
  assert.equal(targeted.status, 'delta');
  assert.equal(targeted.changedSnippets.length, 2);
  assert.ok(targeted.changedSnippets.every((entry: any) => entry.returnedBytes <= 8_000));
  assert.ok(targeted.changedSnippets.some((entry: any) => entry.evidenceKey.startsWith('file:src/Example.ts:')));
  assert.ok(targeted.changedSnippets.some((entry: any) => entry.evidenceKey.startsWith('test:tests/Example.test.ts:')));
});

test('get_repo_context_delta contract exposes planner identity and missing-context inputs', async () => {
  const { devFlowToolDefinitions } = await import('../../src/server/contracts/devflowContract.js');
  const tool = devFlowToolDefinitions.find((entry: any) => entry.name === 'get_repo_context_delta');
  assert.ok(tool);
  const properties = tool.inputSchema?.properties || {};
  for (const field of [
    'intent', 'complexity', 'targetFiles', 'deep', 'disclosureLevel',
    'contextSufficient', 'missingFiles', 'missingSymbols', 'missingTests', 'missingRelationships',
  ]) {
    assert.ok(properties[field], `missing delta contract field ${field}`);
  }
});

test.after(() => {
  stopAllRepoChangeWatchers();
  clearContextHandles();
});
