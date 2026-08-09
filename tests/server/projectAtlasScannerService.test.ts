import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-atlas-scan-'));
process.env.DEVFLOW_APP_ROOT = tempDir;
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

const { scanProjectForAtlas } = await import('../../src/server/services/projectAtlasScannerService.js');

function writeFixtureFile(relativePath: string, content: string) {
  const fullPath = path.join(tempDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

writeFixtureFile('src/server/routes/tasks.ts', [
  "import express from 'express';",
  "import { listTasks } from '../services/taskService.js';",
  'export function registerTaskRoutes(app: express.Express) {',
  "  app.get('/api/tasks', (_req, res) => res.json(listTasks()));",
  '}',
].join('\n'));
writeFixtureFile('src/server/services/taskService.ts', [
  'export function listTasks() {',
  '  return [];',
  '}',
].join('\n'));
writeFixtureFile('src/components/TaskList.tsx', [
  'export function TaskList() {',
  '  return <section>Tasks</section>;',
  '}',
].join('\n'));
writeFixtureFile('src/db/migrations/001_init.ts', 'export const migration = "create tasks";');
writeFixtureFile('tests/server/taskService.test.ts', [
  "import { listTasks } from '../../src/server/services/taskService.js';",
  'listTasks();',
].join('\n'));
writeFixtureFile('scripts/verify.ts', 'export const verify = true;');
writeFixtureFile('settings.gradle.kts', 'include(":app")\ninclude(":library:calendar")');
writeFixtureFile('build.gradle.kts', 'plugins { alias(libs.plugins.android.application) apply false }');
writeFixtureFile('app/build.gradle.kts', 'plugins { alias(libs.plugins.android.application) }\nandroid { namespace = "com.qchang.buddy" }');
writeFixtureFile('app/src/main/AndroidManifest.xml', '<manifest><application android:name="com.qchang.buddy.Application" /></manifest>');
writeFixtureFile('app/src/main/java/com/qchang/buddy/Application.kt', [
  'package com.qchang.buddy',
  'class Application : android.app.Application()',
].join('\n'));
writeFixtureFile('app/src/main/java/com/qchang/buddy/di/ViewModelModules.kt', [
  'package com.qchang.buddy.di',
  'val vmModules = module { viewModel { MainScreenViewModel(get()) } }',
].join('\n'));
writeFixtureFile('app/src/main/java/com/qchang/buddy/data/remote/ApiKeyService.kt', [
  'package com.qchang.buddy.data.remote',
  'interface ApiKeyService {',
  '  @POST("v2/authentication/token/refresh")',
  '  fun refreshToken(): String',
  '}',
].join('\n'));
writeFixtureFile('app/src/main/java/com/qchang/buddy/data/repository/jobs/JobsRepository.kt', [
  'package com.qchang.buddy.data.repository.jobs',
  'interface JobsRepository',
].join('\n'));
writeFixtureFile('app/src/main/res/navigation/nav_main.xml', '<navigation app:startDestination="@id/homeFragment" />');
writeFixtureFile('app/src/main/res/layout/activity_main.xml', '<androidx.fragment.app.FragmentContainerView android:id="@+id/main_nav_host" />');
writeFixtureFile('app/src/main/res/values/strings.xml', '<resources><string name="app_name">Q-BUDDY</string></resources>');
writeFixtureFile('stubby/mock.yaml', 'request:\n  method: POST\nresponse:\n  status: 200\n');
writeFixtureFile('config/project-rules.json', JSON.stringify({
  files: {
    ignoreDirectories: ['node_modules'],
    includeDirectories: ['.github'],
    maxFiles: 100,
    maxFileBytes: 50_000,
  },
}));
writeFixtureFile('node_modules/generated/Ignored.ts', 'export const ignored = true;');

test('scanProjectForAtlas builds deterministic verified graph facts from a small repo', () => {
  const result = scanProjectForAtlas({ projectId: 'project-scan-1', root: tempDir });
  const nodeByPath = new Map(result.atlas.nodes.map((node: any) => [node.path, node]));
  const edgeKinds = new Set(result.atlas.edges.map((edge: any) => edge.kind));

  assert.equal(result.atlas.projectId, 'project-scan-1');
  assert.ok(nodeByPath.has('src/server/routes/tasks.ts'));
  assert.ok(nodeByPath.has('src/server/services/taskService.ts'));
  assert.ok(nodeByPath.has('src/components/TaskList.tsx'));
  assert.ok(nodeByPath.has('src/db/migrations/001_init.ts'));
  assert.ok(nodeByPath.has('tests/server/taskService.test.ts'));
  assert.equal(nodeByPath.has('node_modules/generated/Ignored.ts'), false);
  assert.ok(nodeByPath.has('settings.gradle.kts'));
  assert.ok(nodeByPath.has('build.gradle.kts'));
  assert.ok(nodeByPath.has('app/build.gradle.kts'));
  assert.ok(nodeByPath.has('app/src/main/AndroidManifest.xml'));
  assert.ok(nodeByPath.has('app/src/main/java/com/qchang/buddy/Application.kt'));
  assert.ok(nodeByPath.has('app/src/main/java/com/qchang/buddy/di/ViewModelModules.kt'));
  assert.ok(nodeByPath.has('app/src/main/java/com/qchang/buddy/data/remote/ApiKeyService.kt'));
  assert.ok(nodeByPath.has('app/src/main/java/com/qchang/buddy/data/repository/jobs/JobsRepository.kt'));
  assert.ok(nodeByPath.has('app/src/main/res/navigation/nav_main.xml'));
  assert.ok(nodeByPath.has('app/src/main/res/layout/activity_main.xml'));
  assert.ok(nodeByPath.has('app/src/main/res/values/strings.xml'));
  assert.ok(nodeByPath.has('stubby/mock.yaml'));

  assert.equal(nodeByPath.get('src/server/routes/tasks.ts').metadata.routeCount, 1);
  assert.equal(nodeByPath.get('src/components/TaskList.tsx').metadata.component, true);
  assert.equal(nodeByPath.get('src/db/migrations/001_init.ts').metadata.database, true);
  assert.equal(nodeByPath.get('scripts/verify.ts').metadata.script, true);
  assert.equal(nodeByPath.get('config/project-rules.json').metadata.config, true);
  assert.equal(nodeByPath.get('tests/server/taskService.test.ts').metadata.test, true);
  assert.equal(nodeByPath.get('settings.gradle.kts').metadata.config, true);
  assert.equal(nodeByPath.get('app/build.gradle.kts').metadata.config, true);
  assert.equal(nodeByPath.get('app/src/main/AndroidManifest.xml').metadata.androidManifest, true);
  assert.equal(nodeByPath.get('app/src/main/res/navigation/nav_main.xml').metadata.androidNavigation, true);
  assert.equal(nodeByPath.get('app/src/main/res/layout/activity_main.xml').metadata.androidLayout, true);
  assert.equal(nodeByPath.get('app/src/main/res/values/strings.xml').metadata.androidValues, true);
  assert.equal(nodeByPath.get('stubby/mock.yaml').metadata.stubby, true);

  assert.ok(edgeKinds.has('contains'));
  assert.ok(result.atlas.edges.some((edge: any) =>
    edge.kind === 'imports' &&
    edge.source === 'file:src/server/routes/tasks.ts' &&
    edge.target === 'file:src/server/services/taskService.ts'
  ));
  assert.ok(result.atlas.edges.some((edge: any) =>
    edge.kind === 'tests' &&
    edge.source === 'file:tests/server/taskService.test.ts' &&
    edge.target === 'file:src/server/services/taskService.ts'
  ));

  assert.equal(result.scanStats.scannedFileCount, 19);
  assert.equal(result.scanStats.truncated, false);
  assert.ok(result.scanStats.skippedDirectories.some((entry: string) => entry.includes('node_modules')));
  assert.equal(result.scanStats.warnings.length, 0);
});

test('scanProjectForAtlas supports bounded changed-file scans with known graph paths', () => {
  const result = scanProjectForAtlas({
    projectId: 'project-scan-1',
    root: tempDir,
    paths: ['src/server/routes/tasks.ts'],
    knownFilePaths: ['src/server/routes/tasks.ts', 'src/server/services/taskService.ts'],
  } as any);
  const scannedNodes = result.atlas.nodes.filter((node: any) => typeof node.path === 'string' && node.path.endsWith('.ts'));

  assert.equal(result.scanStats.scannedFileCount, 1);
  assert.deepEqual(scannedNodes.map((node: any) => node.path), ['src/server/routes/tasks.ts']);
  assert.ok(result.atlas.edges.some((edge: any) =>
    edge.kind === 'imports' &&
    edge.source === 'file:src/server/routes/tasks.ts' &&
    edge.target === 'file:src/server/services/taskService.ts'
  ));
});

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});
