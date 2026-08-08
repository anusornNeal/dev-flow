import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-compact-route-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();

const express = (await import('express')).default;
const { registerApiRoutes } = await import('../../src/server/routes/registerApiRoutes.js');
const { createProject } = await import('../../src/server/repositories/projectRepository.js');
const { getToolDefinitionByName, getCapabilityCatalog } = await import('../../src/server/contracts/devflowContract.js');
const { clearFileReferences } = await import('../../src/server/services/fileReferenceService.js');
const { clearPreparedEditPlans } = await import('../../src/server/services/preparedEditService.js');

const project = {
  id: 'project-compact-route',
  name: 'Compact Route Fixture',
  repoUrl: 'https://example.com/compact-route',
  localPath: tempDir,
};
createProject(project as any);
const state: any = { projectsCache: [project], countersCache: {}, skillsRegistry: [] };
fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'const timeout = 30000;\nconst headers = {};\n', 'utf8');

const app = express();
registerApiRoutes(app, { state, writeAgentLog: () => {} });
const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
if (!address || typeof address === 'string') throw new Error('Failed to bind test server');
const baseUrl = `http://127.0.0.1:${address.port}`;

async function json(response: Response) {
  return response.json() as Promise<any>;
}

test.beforeEach(() => {
  clearFileReferences();
  clearPreparedEditPlans();
  fs.writeFileSync(path.join(tempDir, 'sample.txt'), 'const timeout = 30000;\nconst headers = {};\n', 'utf8');
});

test('contract exposes self-describing compact prepare and plan-id-only apply tools', () => {
  const prepare = getToolDefinitionByName('prepare_compact_edit');
  const apply = getToolDefinitionByName('apply_prepared_edit');
  const read = getToolDefinitionByName('read_local_file');

  assert.ok(prepare);
  assert.ok(apply);
  assert.equal(prepare.executionPolicy?.jobKind, 'repo-read');
  assert.equal(apply.executionPolicy?.jobKind, 'repo-write');
  assert.match(prepare.description, /R.*IB.*IA.*DB/s);
  assert.match(prepare.description, /string table|`s`/i);
  assert.ok(read?.inputSchema?.properties?.includeFileRef);

  const prepareRequest = prepare.buildHttpRequest({ projectId: project.id, v: 1, f: [['ref', [['R', 'a', 'b']]]] });
  assert.equal(prepareRequest.method, 'POST');
  assert.equal(prepareRequest.path, '/api/local-files/compact-edit/prepare');

  const applyRequest = apply.buildHttpRequest({ editPlanId: 'edit-plan-example' });
  assert.deepEqual(applyRequest.body, { editPlanId: 'edit-plan-example' });
  assert.equal(Object.keys(apply.inputSchema.properties).sort().join(','), 'editPlanId');
  assert.match(getCapabilityCatalog().contractVersion, /^2026-08-08\.3$/);
});

test('REST compact flow reads a fileRef, prepares without writes, applies by id only, then rejects replay', async () => {
  const readResponse = await fetch(`${baseUrl}/api/local-files/read?projectId=${project.id}&filePath=sample.txt&includeFileRef=true`);
  assert.equal(readResponse.status, 200);
  const readBody = await json(readResponse);
  assert.match(readBody.fileRef, /^file-ref-/);

  const prepareResponse = await fetch(`${baseUrl}/api/local-files/compact-edit/prepare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      projectId: project.id,
      v: 1,
      s: ['const timeout = 30000', 'const headers ='],
      f: [[readBody.fileRef, [
        ['R', 0, 'const timeout = 60000', 1],
        ['IA', 1, '\nconst retryCount = 3;', 1],
      ]]],
    }),
  });
  assert.equal(prepareResponse.status, 200);
  const prepared = await json(prepareResponse);
  assert.equal(prepared.ok, true);
  assert.match(prepared.editPlanId, /^edit-plan-/);
  assert.equal(prepared.compact.stringTableEntries, 2);
  assert.equal(fs.readFileSync(path.join(tempDir, 'sample.txt'), 'utf8'), 'const timeout = 30000;\nconst headers = {};\n');

  const applyResponse = await fetch(`${baseUrl}/api/local-files/compact-edit/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editPlanId: prepared.editPlanId }),
  });
  assert.equal(applyResponse.status, 200);
  const applied = await json(applyResponse);
  assert.equal(applied.ok, true);
  assert.match(fs.readFileSync(path.join(tempDir, 'sample.txt'), 'utf8'), /timeout = 60000/);
  assert.match(fs.readFileSync(path.join(tempDir, 'sample.txt'), 'utf8'), /retryCount = 3/);

  const replayResponse = await fetch(`${baseUrl}/api/local-files/compact-edit/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ editPlanId: prepared.editPlanId }),
  });
  assert.equal(replayResponse.status, 200);
  const replay = await json(replayResponse);
  assert.equal(replay.code, 'EDIT_PLAN_CONSUMED');
});

test.after(async () => {
  clearFileReferences();
  clearPreparedEditPlans();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
});
