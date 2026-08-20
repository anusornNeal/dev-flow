import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const runnerTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-registry-'));
process.env.DEVFLOW_DB_PATH = path.join(runnerTestRoot, 'devflow.db');
process.env.DEVFLOW_RUNTIME_DIR = path.join(runnerTestRoot, 'runtime');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getBuiltinToolRunnerNames, runBuiltinToolJob } = await import('../../src/server/services/mcpToolJobRunnerRegistry.js');

const EXPECTED_RUNNERS = [
  'run_project_command',
  'apply_patch',
  'search_local_files',
  'execute_repo_query_plan',
  'ensure_git_branch',
  'push_git_branch',
  'commit_git_changes',
  'commit_task_owned_changes',
  'edit_local_files_batch',
  'prepare_edit_plan',
  'apply_prepared_edit_plan',
  'prepare_compact_edit',
  'apply_prepared_edit',
  'apply_and_verify',
  'delete_local_path',
  'move_local_path',
  'apply_project_atlas_agent_update',
];

test('runner registry owns the complete built-in async dispatch surface', () => {
  assert.deepEqual(getBuiltinToolRunnerNames(), EXPECTED_RUNNERS);
});

test('direct run_project_command retries proven infrastructure failure through a recovery capacity lease', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-runner-infra-retry-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const marker = path.join(os.tmpdir(), `devflow-runner-infra-retry-${path.basename(root)}.txt`);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node scripts/test.mjs' } }, null, 2));
  fs.writeFileSync(path.join(root, 'scripts', 'test.mjs'), [
    "import fs from 'node:fs';",
    `const marker = ${JSON.stringify(marker)};`,
    "const attempt = fs.existsSync(marker) ? Number(fs.readFileSync(marker, 'utf8')) + 1 : 1;",
    "fs.writeFileSync(marker, String(attempt), 'utf8');",
    "if (process.env.DEVFLOW_VERIFICATION_RECOVERY !== 'resource-safe') { process.stderr.write('java.lang.OutOfMemoryError: Java heap space\\n'); process.exit(1); }",
    "process.stdout.write('runner recovered\\n');",
  ].join('\n'));
  createProject({ id: 'project-runner-retry', name: 'Runner Retry', repoUrl: 'https://example.test/runner-retry', localPath: root });
  const state = { projectsCache: [{ id: 'project-runner-retry', name: 'Runner Retry', repoUrl: 'https://example.test/runner-retry', localPath: root }] } as any;
  const transitionRequests: any[] = [];
  const permitRequests: any[] = [];
  const result = await runBuiltinToolJob({
    toolName: 'run_project_command', state,
    args: { projectId: 'project-runner-retry', command: 'test', cacheResult: false, forceFresh: true, infrastructureRetryPolicy: 'resource-safe-once' },
  }, {
    logger: { stdout: () => {}, stderr: () => {} },
    setCancelFn: () => {},
    transitionAccess: async (mode: any, request: any) => {
      transitionRequests.push({ mode, request });
      return {
        runWithPermit: async (permitRequest: any, run: () => Promise<any>) => {
          permitRequests.push(permitRequest);
          return await run();
        },
        dispose: () => {},
      };
    },
  }) as any;

  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(marker, 'utf8'), '2');
  assert.equal(result.infrastructureRecovery?.retryCount, 1);
  assert.equal(transitionRequests.length, 1, 'direct recovery requests capacity only after proven infrastructure failure');
  assert.equal(transitionRequests[0].mode, 'verify');
  assert.equal(transitionRequests[0].request.sharedResources?.includes('verification-recovery'), true);
  assert.equal(permitRequests.length, 1);
});

test('runner registry rejects unknown async tools explicitly', async () => {
  await assert.rejects(
    runBuiltinToolJob({ toolName: 'missing_tool', state: {} as any, args: {} }, {
      logger: { stdout: () => {}, stderr: () => {} },
      setCancelFn: () => {},
      transitionAccess: () => {},
    }),
    /No async runner implemented for tool: missing_tool/,
  );
});
