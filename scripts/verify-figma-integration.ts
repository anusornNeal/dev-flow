import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import express from 'express';
import { getSettings } from '../src/server/repositories/settingsRepository.js';
import { createProject, getProjects } from '../src/server/repositories/projectRepository.js';
import type { AppState, ApiRouteDeps } from '../src/server/types.js';

const { registerSettingsRoutes } = await import('../src/server/routes/settings.js');
const { FigmaService } = await import('../src/server/services/figmaService.js');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-figma-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');

async function withServer(
  appFactory: () => { app: express.Express; deps: ApiRouteDeps },
  run: (baseUrl: string, deps: ApiRouteDeps) => Promise<void>,
) {
  const { app, deps } = appFactory();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server.');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  try {
    await run(baseUrl, deps);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

console.log('[Figma] verifying Figma token masking and update via settings...');
await withServer(() => {
  const state: AppState = {
    tasksCache: [],
    countersCache: {},
    
    skillsRegistry: [],
  };
  try { createProject({ id: 'project-1', name: 'p1', repoUrl: 'repo', localPath: process.cwd() }); } catch(e) {}
  const deps: ApiRouteDeps = { state, writeAgentLog: () => {} };
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, deps);
  return { app, deps };
}, async (baseUrl, deps) => {
  // Test 1: Update token
  const updateRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ figmaToken: 'fake-figma-token' }),
  });
  assert.equal(updateRes.status, 200);
  assert.equal(getSettings().figmaToken, 'fake-figma-token');

  // Test 2: Read settings (should be masked)
  const getRes = await fetch(`${baseUrl}/api/settings`);
  const getData = await getRes.json();
  assert.equal(getData.figmaTokenMasked, true);
  assert.equal(getData.figmaToken, undefined);

  // Test 3: Clear token
  const clearRes = await fetch(`${baseUrl}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clearFigmaToken: true, figmaToken: '' }),
  });
  assert.equal(clearRes.status, 200);
  assert.equal(getSettings().figmaToken, '');
});

console.log('[Figma] verifying Figma Service Normalization...');
const service = new FigmaService('dummy-token');
const normalized = (service as any).normalizeNode({
  id: '1:1',
  name: 'Test Node',
  type: 'FRAME',
  absoluteBoundingBox: { width: 100, height: 200 },
  style: { fontFamily: 'Inter', fontWeight: 400, fontSize: 16, textAlignHorizontal: 'LEFT' },
  fills: [{ type: 'SOLID', color: { r: 1, g: 0, b: 0, a: 1 } }],
  strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0, a: 0.5 } }],
  strokeWeight: 2,
  cornerRadius: 8,
  layoutMode: 'HORIZONTAL',
  paddingTop: 10,
  paddingRight: 20,
  paddingBottom: 10,
  paddingLeft: 20,
  itemSpacing: 8,
});

assert.equal(normalized.id, '1:1');
assert.equal(normalized.name, 'Test Node');
assert.equal(normalized.type, 'FRAME');
assert.equal(normalized.bounds.width, 100);
assert.equal(normalized.typography.color, '#ff0000'); // Fills go to typography if text style exists
assert.equal(normalized.borderColor, 'rgba(0, 0, 0, 0.50)');
assert.equal(normalized.layout.mode, 'HORIZONTAL');
assert.equal(normalized.layout.padding[1], 20);

console.log('[Figma] Verify Figma API Request Error Throwing...');
try {
  const badService = new FigmaService('');
  await badService.getFigmaFile('some-key');
  assert.fail('Should have thrown an error for empty token');
} catch (e: any) {
  assert.match(e.message, /Figma token is not configured/);
}

console.log('[verify-figma-integration] all assertions passed!');
