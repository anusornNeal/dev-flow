import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-contract-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const scratchDir = path.join(tempDir, 'scratch');
fs.mkdirSync(scratchDir, { recursive: true });
fs.writeFileSync(path.join(scratchDir, 'note.txt'), 'needle line\nsecond line\n', 'utf8');
const commandSubdir = path.join(tempDir, 'subdir');
fs.mkdirSync(commandSubdir, { recursive: true });
const reportsDir = path.join(tempDir, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });
fs.writeFileSync(
  path.join(reportsDir, 'tsc-failure.txt'),
  [
    'src/server/example.ts(12,5): error TS2322: Type \'number\' is not assignable to type \'string\'.',
    'src/server/example.ts(18,9): error TS7006: Parameter \'value\' implicitly has an \'any\' type.',
    '',
  ].join('\n'),
  'utf8',
);
fs.writeFileSync(
  path.join(tempDir, 'package.json'),
  JSON.stringify({
    name: 'devflow-contract-fixture',
    private: true,
    scripts: {
      typecheck: 'node -e "console.log(\'fixture-typecheck-ok\')"',
      test: 'node -e "console.error(\'fixture-test-fail\'); process.exit(2)"',
      verify: 'node -e "setTimeout(() => console.log(\'fixture-verify-finished\'), 250)"',
      lint: 'node -e "process.stdout.write(\'x\'.repeat(1200))"',
      build: 'node -e "console.log(process.env.INIT_CWD || process.cwd())"',
    },
  }, null, 2),
  'utf8',
);

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../src/server/routes/registerApiRoutes.js');
const { saveProjects } = await import('../src/server/repositories/projectRepository.js');
const { saveTasks } = await import('../src/server/repositories/taskRepository.js');
const { getCapabilityCatalog, getMcpToolList, getToolDefinitionByName } = await import('../src/server/contracts/devflowContract.js');

const state = {
  tasksCache: [
    {
      id: 'task-contract-1',
      displayId: 'DVF-0120',
      title: 'Contract refactor task',
      description: 'Use one shared contract for REST and MCP.',
      projectId: 'project-contract-1',
      status: 'backlog',
      priority: 'high',
      checklist: [{ id: 'chk-1', text: 'ship contract layer', completed: false }],
      logs: [],
      createdAt: '2026-06-13T00:00:00.000Z',
      updatedAt: '2026-06-13T00:00:00.000Z',
    },
  ],
  projectsCache: [
    {
      id: 'project-contract-1',
      name: 'Dev Flow',
      repoUrl: 'https://github.com/anusornNeal/dev-flow',
      localPath: tempDir,
      taskIdPrefix: 'DVF',
      createdAt: '2026-06-13T00:00:00.000Z',
    },
  ],
  countersCache: {},
  settingsCache: {
    ngrokUrl: '',
    githubToken: '',
    jiraToken: '',
    jiraBaseUrl: '',
    jiraEmail: '',
    autoWork: false,
    agentExecutionMode: 'safe',
  },
  skillsRegistry: [],
};

saveProjects(state as any);
saveTasks(state as any);

const app = express();
registerApiRoutes(app, {
  state: state as any,
  writeAgentLog: () => {},
});

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, resolve));
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Failed to bind verification server.');
}

const baseUrl = `http://127.0.0.1:${address.port}`;

try {
  console.log('[verify] Testing capabilities endpoint...');
  const capabilitiesResponse = await fetch(`${baseUrl}/api/capabilities`);
  assert.equal(capabilitiesResponse.status, 200);
  const capabilitiesBody = await capabilitiesResponse.json();
  const catalog = getCapabilityCatalog();
  assert.equal(capabilitiesBody.contractVersion, catalog.contractVersion);
  assert.equal(capabilitiesBody.counts.tools, catalog.tools.length);
  assert.ok(capabilitiesBody.tools.some((tool: any) => tool.name === 'get_capabilities'));
  assert.ok(capabilitiesBody.tools.some((tool: any) => tool.name === 'import_tasks_from_file'));

  console.log('[verify] Testing task summary/query modes...');
  const listResponse = await fetch(`${baseUrl}/api/tasks?mode=summary&q=contract`);
  assert.equal(listResponse.status, 200);
  const listBody = await listResponse.json();
  assert.equal(listBody.total, 1);
  assert.equal(listBody.items[0].displayId, 'DVF-0120');
  assert.equal(listBody.items[0].description, undefined);

  const getTaskResponse = await fetch(`${baseUrl}/api/tasks/DVF-0120?mode=minimal`);
  assert.equal(getTaskResponse.status, 200);
  const getTaskBody = await getTaskResponse.json();
  assert.equal(getTaskBody.id, 'task-contract-1');
  assert.equal(getTaskBody.title, 'Contract refactor task');

  console.log('[verify] Testing batch move/assign/checklist endpoints...');
  const moveResponse = await fetch(`${baseUrl}/api/tasks/batch/move`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ moves: [{ taskId: 'DVF-0120', status: 'todo' }] }),
  });
  assert.equal(moveResponse.status, 200);
  const moveBody = await moveResponse.json();
  assert.equal(moveBody.successCount, 1);
  assert.equal(state.tasksCache[0].status, 'todo');

  const assignResponse = await fetch(`${baseUrl}/api/tasks/batch/assign`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignments: [{ taskId: 'DVF-0120', agent: 'Codex', model: 'GPT-5.4', effort: 'medium' }] }),
  });
  assert.equal(assignResponse.status, 200);
  const assignBody = await assignResponse.json();
  assert.equal(assignBody.successCount, 1);
  assert.equal((state.tasksCache[0] as any).agent, 'Codex');

  const toggleResponse = await fetch(`${baseUrl}/api/tasks/batch/checklist/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toggles: [{ taskId: 'DVF-0120', checklistId: 'chk-1' }] }),
  });
  assert.equal(toggleResponse.status, 200);
  const toggleBody = await toggleResponse.json();
  assert.equal(toggleBody.successCount, 1);
  assert.equal(state.tasksCache[0].checklist[0].completed, true);

  console.log('[verify] Testing local file tools...');
  const listFilesResponse = await fetch(`${baseUrl}/api/local-files?projectId=project-contract-1&path=scratch`);
  assert.equal(listFilesResponse.status, 200);
  const listFilesBody = await listFilesResponse.json();
  assert.ok(listFilesBody.files.some((entry: any) => entry.path.endsWith('note.txt')));

  const readFileResponse = await fetch(`${baseUrl}/api/local-files/read?projectId=project-contract-1&filePath=scratch/note.txt`);
  assert.equal(readFileResponse.status, 200);
  const readFileBody = await readFileResponse.json();
  assert.match(readFileBody.content, /needle line/);

  const searchFilesResponse = await fetch(`${baseUrl}/api/local-files/search?projectId=project-contract-1&query=needle&path=scratch`);
  assert.equal(searchFilesResponse.status, 200);
  const searchFilesBody = await searchFilesResponse.json();
  assert.equal(searchFilesBody.count, 1);
  assert.equal(searchFilesBody.matches[0].line, 1);

  console.log('[verify] Testing local patch tool...');
  const dryRunPatch = [
    '--- a/scratch/note.txt',
    '+++ b/scratch/note.txt',
    '@@ -1,2 +1,2 @@',
    '-needle line',
    '+patched needle line',
    ' second line',
    '',
  ].join('\n');
  const dryRunPatchResponse = await fetch(`${baseUrl}/api/local-files/apply-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', patch: dryRunPatch, dryRun: true }),
  });
  assert.equal(dryRunPatchResponse.status, 200);
  const dryRunPatchBody = await dryRunPatchResponse.json();
  assert.equal(dryRunPatchBody.applied, false);
  assert.equal(dryRunPatchBody.dryRun, true);
  assert.deepEqual(dryRunPatchBody.changedFiles, ['scratch/note.txt']);
  assert.match(fs.readFileSync(path.join(scratchDir, 'note.txt'), 'utf8'), /^needle line/);

  const applyPatchResponse = await fetch(`${baseUrl}/api/local-files/apply-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', patch: dryRunPatch, dryRun: false }),
  });
  assert.equal(applyPatchResponse.status, 200);
  const applyPatchBody = await applyPatchResponse.json();
  assert.equal(applyPatchBody.applied, true);
  assert.equal(applyPatchBody.dryRun, false);
  assert.deepEqual(applyPatchBody.changedFiles, ['scratch/note.txt']);
  assert.match(applyPatchBody.summary, /scratch\/note\.txt/);
  assert.match(fs.readFileSync(path.join(scratchDir, 'note.txt'), 'utf8'), /^patched needle line/);

  const unsafePatch = [
    '--- a/../outside.txt',
    '+++ b/../outside.txt',
    '@@ -0,0 +1 @@',
    '+outside',
    '',
  ].join('\n');
  const unsafePatchResponse = await fetch(`${baseUrl}/api/local-files/apply-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', patch: unsafePatch, dryRun: true }),
  });
  assert.equal(unsafePatchResponse.status, 403);
  const unsafePatchBody = await unsafePatchResponse.json();
  assert.equal(unsafePatchBody.error.code, 'PATCH_PATH_DENIED');

  const binaryPatch = [
    'diff --git a/scratch/image.bin b/scratch/image.bin',
    'new file mode 100644',
    'index 0000000..1111111',
    'GIT binary patch',
    'literal 0',
    '',
  ].join('\n');
  const binaryPatchResponse = await fetch(`${baseUrl}/api/local-files/apply-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', patch: binaryPatch, dryRun: true }),
  });
  assert.equal(binaryPatchResponse.status, 400);
  const binaryPatchBody = await binaryPatchResponse.json();
  assert.equal(binaryPatchBody.error.code, 'BINARY_PATCH_UNSUPPORTED');

  const invalidPatchResponse = await fetch(`${baseUrl}/api/local-files/apply-patch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', patch: 'not a unified diff', dryRun: true }),
  });
  assert.equal(invalidPatchResponse.status, 400);
  const invalidPatchBody = await invalidPatchResponse.json();
  assert.equal(invalidPatchBody.error.code, 'INVALID_PATCH');

  console.log('[verify] Testing project command tool...');
  const typecheckCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'typecheck' }),
  });
  assert.equal(typecheckCommandResponse.status, 200);
  const typecheckCommandBody = await typecheckCommandResponse.json();
  assert.equal(typecheckCommandBody.command, 'typecheck');
  assert.equal(typecheckCommandBody.exitCode, 0);
  assert.equal(typecheckCommandBody.timedOut, false);
  assert.match(typecheckCommandBody.stdout, /fixture-typecheck-ok/);

  const failingCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'test' }),
  });
  assert.equal(failingCommandResponse.status, 200);
  const failingCommandBody = await failingCommandResponse.json();
  assert.equal(failingCommandBody.command, 'test');
  assert.equal(failingCommandBody.exitCode, 2);
  assert.equal(failingCommandBody.timedOut, false);
  assert.match(failingCommandBody.stderr, /fixture-test-fail/);

  const timeoutCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'verify', timeoutMs: 50 }),
  });
  assert.equal(timeoutCommandResponse.status, 200);
  const timeoutCommandBody = await timeoutCommandResponse.json();
  assert.equal(timeoutCommandBody.command, 'verify');
  assert.equal(timeoutCommandBody.timedOut, true);

  const truncatedCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'lint', maxOutputBytes: 80 }),
  });
  assert.equal(truncatedCommandResponse.status, 200);
  const truncatedCommandBody = await truncatedCommandResponse.json();
  assert.equal(truncatedCommandBody.command, 'lint');
  assert.equal(truncatedCommandBody.stdoutTruncated, true);
  assert.ok(truncatedCommandBody.stdout.length <= 100);

  const cwdCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'build', cwd: 'subdir' }),
  });
  assert.equal(cwdCommandResponse.status, 200);
  const cwdCommandBody = await cwdCommandResponse.json();
  assert.equal(cwdCommandBody.command, 'build');
  assert.match(String(cwdCommandBody.stdout).replace(/\\/g, '/'), /subdir/);

  const unknownCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'npm test' }),
  });
  assert.equal(unknownCommandResponse.status, 400);
  const unknownCommandBody = await unknownCommandResponse.json();
  assert.equal(unknownCommandBody.error.code, 'COMMAND_NOT_ALLOWED');

  const unsafeCwdCommandResponse = await fetch(`${baseUrl}/api/project-commands/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', command: 'typecheck', cwd: '../elsewhere' }),
  });
  assert.equal(unsafeCwdCommandResponse.status, 403);
  const unsafeCwdCommandBody = await unsafeCwdCommandResponse.json();
  assert.equal(unsafeCwdCommandBody.error.code, 'COMMAND_CWD_DENIED');

  console.log('[verify] Testing test report parser tool...');
  const passingReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      rawOutput: '[verify] Running lint...\n[verify] Verification completed successfully.\n',
    }),
  });
  assert.equal(passingReportResponse.status, 200);
  const passingReportBody = await passingReportResponse.json();
  assert.equal(passingReportBody.status, 'passed');
  assert.equal(passingReportBody.parserKind, 'devflow-verify');
  assert.equal(passingReportBody.errorSnippets.length, 0);
  assert.equal(passingReportBody.suggestedNextCommand, null);

  const tscReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      rawOutput: 'src/server/example.ts(12,5): error TS2322: Type \'number\' is not assignable to type \'string\'.\n',
    }),
  });
  assert.equal(tscReportResponse.status, 200);
  const tscReportBody = await tscReportResponse.json();
  assert.equal(tscReportBody.status, 'failed');
  assert.equal(tscReportBody.parserKind, 'tsc');
  assert.deepEqual(tscReportBody.failingFiles, ['src/server/example.ts']);
  assert.match(tscReportBody.errorSnippets[0], /TS2322/);
  assert.equal(tscReportBody.suggestedNextCommand, 'npm run typecheck');

  const assertionReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      rawOutput: 'AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n\n1 !== 2\n\n    at <anonymous> (C:\\\\repo\\\\scripts\\\\verify.ts:10:3)\n',
    }),
  });
  assert.equal(assertionReportResponse.status, 200);
  const assertionReportBody = await assertionReportResponse.json();
  assert.equal(assertionReportBody.status, 'failed');
  assert.equal(assertionReportBody.parserKind, 'node-assertion');
  assert.match(assertionReportBody.errorSnippets[0], /ERR_ASSERTION/);
  assert.match(assertionReportBody.failingFiles[0], /scripts\/verify\.ts|scripts\\verify\.ts/);

  const fileReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      reportPaths: ['reports/tsc-failure.txt'],
    }),
  });
  assert.equal(fileReportResponse.status, 200);
  const fileReportBody = await fileReportResponse.json();
  assert.equal(fileReportBody.status, 'failed');
  assert.deepEqual(fileReportBody.source.reportPaths, ['reports/tsc-failure.txt']);
  assert.match(fileReportBody.errorSnippets[0], /TS2322/);

  const oversizedReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      rawOutput: `AssertionError [ERR_ASSERTION]: ${'x'.repeat(5000)}`,
      maxBytes: 120,
    }),
  });
  assert.equal(oversizedReportResponse.status, 200);
  const oversizedReportBody = await oversizedReportResponse.json();
  assert.equal(oversizedReportBody.truncated, true);
  assert.ok(oversizedReportBody.consumedBytes <= 133);

  const combinedOversizedReportResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      rawOutput: `AssertionError [ERR_ASSERTION]: ${'x'.repeat(80)}`,
      reportPaths: ['reports/tsc-failure.txt'],
      maxBytes: 120,
    }),
  });
  assert.equal(combinedOversizedReportResponse.status, 200);
  const combinedOversizedReportBody = await combinedOversizedReportResponse.json();
  assert.equal(combinedOversizedReportBody.truncated, true);
  assert.ok(combinedOversizedReportBody.consumedBytes <= 133);
  assert.deepEqual(combinedOversizedReportBody.source.reportPaths, ['reports/tsc-failure.txt']);

  const unsafeReportPathResponse = await fetch(`${baseUrl}/api/test-reports/parse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: 'project-contract-1',
      reportPaths: ['../outside.txt'],
    }),
  });
  assert.equal(unsafeReportPathResponse.status, 403);
  const unsafeReportPathBody = await unsafeReportPathResponse.json();
  assert.equal(unsafeReportPathBody.error.code, 'REPORT_PATH_DENIED');

  console.log('[verify] Testing structured error normalization...');
  const missingProjectFileResponse = await fetch(`${baseUrl}/api/local-files?projectName=missing-project&path=scratch`);
  assert.equal(missingProjectFileResponse.status, 404);
  const missingProjectFileBody = await missingProjectFileResponse.json();
  assert.equal(missingProjectFileBody.error.code, 'PROJECT_NOT_FOUND');
  assert.equal(typeof missingProjectFileBody.error.message, 'string');
  assert.equal(typeof missingProjectFileBody.error.retryable, 'boolean');
  assert.equal(typeof missingProjectFileBody.error.correlationId, 'string');

  console.log('[verify] Testing MCP tool catalog parity and aliases...');
  const mcpTools = getMcpToolList();
  assert.ok(mcpTools.some((tool) => tool.name === 'get_agent_context'));
  assert.ok(mcpTools.some((tool) => tool.name === 'get_agent_task_context'));
  assert.ok(mcpTools.some((tool) => tool.name === 'import_tasks_from_file'));
  assert.ok(mcpTools.some((tool) => tool.name === 'apply_patch'));
  assert.ok(mcpTools.some((tool) => tool.name === 'run_project_command'));
  assert.ok(mcpTools.some((tool) => tool.name === 'parse_test_report'));
  assert.ok(mcpTools.length > catalog.tools.length);

  const createTaskSchema = catalog.tools.find((tool) => tool.name === 'create_task')?.inputSchema;
  const updateTaskSchema = catalog.tools.find((tool) => tool.name === 'update_task')?.inputSchema;
  const qualityTool = catalog.tools.find((tool) => tool.name === 'validate_task_quality');
  const repoIndexTool = catalog.tools.find((tool) => tool.name === 'get_repo_inspection_index');
  const jiraBundleTool = catalog.tools.find((tool) => tool.name === 'get_jira_authoring_bundle');
  const jiraDraftTool = catalog.tools.find((tool) => tool.name === 'draft_task_from_jira');
  const applyPatchTool = catalog.tools.find((tool) => tool.name === 'apply_patch');
  const runProjectCommandTool = catalog.tools.find((tool) => tool.name === 'run_project_command');
  const parseTestReportTool = catalog.tools.find((tool) => tool.name === 'parse_test_report');
  assert.ok(createTaskSchema?.properties?.title);
  assert.ok(createTaskSchema?.properties?.projectId);
  assert.ok(createTaskSchema?.properties?.repoUrl);
  assert.ok(createTaskSchema?.properties?.idempotencyKey);
  assert.ok(updateTaskSchema?.properties?.taskId);
  assert.ok(updateTaskSchema?.properties?.idempotencyKey);
  assert.ok(qualityTool, 'validate_task_quality must be advertised in the MCP catalog');
  assert.ok(repoIndexTool, 'get_repo_inspection_index must be advertised in the MCP catalog');
  assert.ok(jiraBundleTool, 'get_jira_authoring_bundle must be advertised in the MCP catalog');
  assert.ok(jiraDraftTool, 'draft_task_from_jira must be advertised in the MCP catalog');
  assert.ok(applyPatchTool, 'apply_patch must be advertised in the MCP catalog');
  assert.ok(runProjectCommandTool, 'run_project_command must be advertised in the MCP catalog');
  assert.ok(parseTestReportTool, 'parse_test_report must be advertised in the MCP catalog');
  assert.match(String(qualityTool?.description || ''), /Implementation map/i);
  assert.match(String(repoIndexTool?.description || ''), /cached/i);
  assert.match(String(jiraBundleTool?.description || ''), /Jira issue packet/i);
  assert.match(String(jiraDraftTool?.description || ''), /DevFlow Gateway/i);
  assert.match(String(applyPatchTool?.description || ''), /unified diff/i);
  assert.match(String(runProjectCommandTool?.description || ''), /allowlisted|verification/i);
  assert.match(String(parseTestReportTool?.description || ''), /summary|report/i);

  const applyPatchRequest = getToolDefinitionByName('apply_patch')?.buildHttpRequest({
    projectId: 'project-contract-1',
    patch: dryRunPatch,
    dryRun: true,
  });
  assert.equal(applyPatchRequest?.method, 'POST');
  assert.equal(applyPatchRequest?.path, '/api/local-files/apply-patch');
  assert.equal((applyPatchRequest?.body as any)?.patch, dryRunPatch);
  assert.equal((applyPatchRequest?.body as any)?.dryRun, true);

  const runProjectCommandRequest = getToolDefinitionByName('run_project_command')?.buildHttpRequest({
    projectId: 'project-contract-1',
    command: 'typecheck',
    cwd: 'subdir',
    timeoutMs: 500,
  });
  assert.equal(runProjectCommandRequest?.method, 'POST');
  assert.equal(runProjectCommandRequest?.path, '/api/project-commands/run');
  assert.equal((runProjectCommandRequest?.body as any)?.command, 'typecheck');
  assert.equal((runProjectCommandRequest?.body as any)?.cwd, 'subdir');

  const parseTestReportRequest = getToolDefinitionByName('parse_test_report')?.buildHttpRequest({
    projectId: 'project-contract-1',
    rawOutput: 'ok',
    reportPaths: ['reports/tsc-failure.txt'],
    maxBytes: 500,
  });
  assert.equal(parseTestReportRequest?.method, 'POST');
  assert.equal(parseTestReportRequest?.path, '/api/test-reports/parse');
  assert.equal((parseTestReportRequest?.body as any)?.rawOutput, 'ok');
  assert.deepEqual((parseTestReportRequest?.body as any)?.reportPaths, ['reports/tsc-failure.txt']);

  const jiraDraftRequest = getToolDefinitionByName('draft_task_from_jira')?.buildHttpRequest({
    jiraKey: 'QCA-3435',
    projectId: 'project-contract-1',
    idempotencyKey: 'contract-draft-key',
  });
  assert.equal(jiraDraftRequest?.method, 'POST');
  assert.equal(jiraDraftRequest?.path, '/api/tasks/draft-from-jira');
  assert.equal((jiraDraftRequest?.body as any)?.jiraKey, 'QCA-3435');
  assert.equal((jiraDraftRequest?.body as any)?.idempotencyKey, 'contract-draft-key');

  const jiraDraftAliasRequest = getToolDefinitionByName('draft_task_from_jira')?.buildHttpRequest({
    issueKey: 'QCA-3436',
    projectId: 'project-contract-1',
  });
  assert.equal((jiraDraftAliasRequest?.body as any)?.jiraKey, 'QCA-3436');
  assert.equal(
    Array.isArray((jiraDraftTool?.inputSchema as any)?.anyOf),
    true,
    'draft_task_from_jira schema must allow jiraKey, issueKey, or key aliases for strict MCP clients',
  );

  console.log('[verify] Testing ChatGPT-friendly task listing defaults...');
  const listTasksTool = getToolDefinitionByName('list_tasks');
  assert.ok(listTasksTool, 'list_tasks must be resolvable by name');
  const defaultListTasksRequest = listTasksTool.buildHttpRequest({});
  assert.equal(defaultListTasksRequest.method, 'GET');
  assert.equal(defaultListTasksRequest.path, '/api/tasks?mode=minimal&limit=50');
  assert.match(listTasksTool.description, /local/i);
  assert.match(listTasksTool.description, /limit/i);

  const readLocalTool = getToolDefinitionByName('read_local_file');
  assert.ok(readLocalTool, 'read_local_file must be resolvable by name');
  assert.match(readLocalTool.description, /Prefer this/i);

  console.log('[verify] Testing prompt override MCP tools...');
  const newToolNames = ['list_prompt_skills', 'get_prompt_skill', 'update_prompt_override', 'delete_prompt_override'];
  for (const toolName of newToolNames) {
    assert.ok(
      catalog.tools.some((tool) => tool.name === toolName),
      `Missing tool in catalog: ${toolName}`,
    );
    assert.ok(
      mcpTools.some((tool) => tool.name === toolName),
      `Missing tool in MCP list: ${toolName}`,
    );
  }
  const updateOverrideSchema = catalog.tools.find((tool) => tool.name === 'update_prompt_override')?.inputSchema as any;
  const getSkillSchema = catalog.tools.find((tool) => tool.name === 'get_prompt_skill')?.inputSchema as any;
  const deleteOverrideSchema = catalog.tools.find((tool) => tool.name === 'delete_prompt_override')?.inputSchema as any;
  assert.ok(Array.isArray(updateOverrideSchema?.required) && updateOverrideSchema.required.includes('sectionId') && updateOverrideSchema.required.includes('content'));
  assert.ok(Array.isArray(getSkillSchema?.required) && getSkillSchema.required.includes('sectionId'));
  assert.ok(Array.isArray(deleteOverrideSchema?.required) && deleteOverrideSchema.required.includes('sectionId'));
  assert.ok(updateOverrideSchema?.properties?.projectId);
  assert.ok(updateOverrideSchema?.properties?.localPath);

  // Verify the contract-level buildHttpRequest mapping actually produces the
  // right body shape (MCP tool path, not hand-written HTTP body).
  const updateOverrideTool = getToolDefinitionByName('update_prompt_override');
  assert.ok(updateOverrideTool, 'update_prompt_override must be resolvable by name');
  const contractReq = updateOverrideTool.buildHttpRequest({
    projectId: 'project-contract-1',
    sectionId: 'prompt.header',
    content: '# from contract',
    agent: 'codex',
    pipeline: 'default',
  });
  assert.equal(contractReq.method, 'PUT');
  assert.equal(contractReq.path, '/api/prompt-overrides/section');
  assert.ok(contractReq.body, 'PUT body must be present');
  assert.equal((contractReq.body as Record<string, unknown>)?.sectionId, 'prompt.header');
  assert.equal((contractReq.body as Record<string, unknown>)?.content, '# from contract');
  assert.equal((contractReq.body as Record<string, unknown>)?.projectId, 'project-contract-1');
  assert.equal((contractReq.body as Record<string, unknown>)?.agent, 'codex');
  assert.equal((contractReq.body as Record<string, unknown>)?.pipeline, 'default');

  // HTTP round-trip: write override, read it, delete it, read again.
  const overrideContent = '# test override\n\nfor prompt.header\n';
  const putResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: 'prompt.header', content: overrideContent }),
  });
  assert.equal(putResp.status, 200);
  const putBody = await putResp.json();
  assert.equal(putBody.success, true);
  assert.ok(putBody.overridePath && putBody.overridePath.endsWith('prompt.header.md'));

  const getAfterPut = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`);
  assert.equal(getAfterPut.status, 200);
  const getAfterPutBody = await getAfterPut.json();
  assert.equal(getAfterPutBody.section.overrideContent, overrideContent);
  assert.equal(getAfterPutBody.section.effectiveContent, overrideContent);
  assert.equal(getAfterPutBody.section.sourceType, 'override');

  const sectionsResp = await fetch(`${baseUrl}/api/prompt-overrides/sections?projectId=project-contract-1`);
  assert.equal(sectionsResp.status, 200);
  const sectionsBody = await sectionsResp.json();
  assert.ok(Array.isArray(sectionsBody.sections));
  assert.ok(sectionsBody.sections.length > 0);
  const headerSection = sectionsBody.sections.find((s: any) => s.id === 'prompt.header');
  assert.ok(headerSection, 'list must include prompt.header section');
  assert.equal(headerSection.sourceType, 'override');
  assert.equal(headerSection.overrideAvailable, true);
  assert.equal(headerSection.masterAvailable, true);
  // Compactness: list response must NOT include large content fields.
  assert.equal(headerSection.masterContent, undefined);
  assert.equal(headerSection.overrideContent, undefined);
  assert.equal(headerSection.effectiveContent, undefined);

  const deleteResp = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`, { method: 'DELETE' });
  assert.equal(deleteResp.status, 200);
  const deleteBody = await deleteResp.json();
  assert.equal(deleteBody.success, true);
  assert.equal(deleteBody.removed, true);

  const getAfterDelete = await fetch(`${baseUrl}/api/prompt-overrides/section?projectId=project-contract-1&sectionId=prompt.header`);
  assert.equal(getAfterDelete.status, 200);
  const getAfterDeleteBody = await getAfterDelete.json();
  assert.equal(getAfterDeleteBody.section.sourceType, 'master');
  assert.equal(getAfterDeleteBody.section.overrideContent, undefined);

  // Path-traversal / invalid id rejection
  const traversalResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: '../etc/passwd', content: 'x' }),
  });
  assert.equal(traversalResp.status, 400);
  const traversalBody = await traversalResp.json();
  assert.equal(traversalBody.error.code, 'INVALID_SECTION_ID');

  const unknownIdResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: 'project-contract-1', sectionId: 'prompt.unknown.thing', content: 'x' }),
  });
  assert.equal(unknownIdResp.status, 400);
  const unknownIdBody = await unknownIdResp.json();
  assert.equal(unknownIdBody.error.code, 'INVALID_SECTION_ID');

  // Missing project / no localPath resolution
  const noProjectResp = await fetch(`${baseUrl}/api/prompt-overrides/section`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sectionId: 'prompt.header', content: 'x' }),
  });
  assert.equal(noProjectResp.status, 400);
  const noProjectBody = await noProjectResp.json();
  assert.equal(noProjectBody.error.code, 'INVALID_PROJECT');

  console.log('[verify-devflow-contract] all assertions passed');
} finally {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
