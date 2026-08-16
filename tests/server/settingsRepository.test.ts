import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-settings-repository-'));
process.env.DEVFLOW_APP_ROOT = tempRoot;
process.env.DEVFLOW_DB_PATH = path.join(tempRoot, 'data', 'devflow.sqlite');
fs.mkdirSync(path.dirname(process.env.DEVFLOW_DB_PATH), { recursive: true });

const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();
const db = (await import('../../src/db/index.js')).default;
const { getSettings, saveSettings } = await import('../../src/server/repositories/settingsRepository.js');
const { registerSettingsRoutes } = await import('../../src/server/routes/settings.js');

function resetSettings() {
  db.prepare('DELETE FROM settings').run();
}

function insertLegacyNgrokUrl(value: string) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('ngrokUrl', value);
}

function readStoredValue(key: string) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

async function withSettingsServer(run: (baseUrl: string) => Promise<void>) {
  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, {
    state: { countersCache: {} },
    writeAgentLog: () => {},
  } as any);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind settings test server.');
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test.beforeEach(resetSettings);

test('getSettings ignores a legacy ngrokUrl row while preserving unrelated settings', () => {
  insertLegacyNgrokUrl('https://legacy-ngrok.example.invalid');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jiraBaseUrl', 'https://jira.example.invalid');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jiraEmail', 'dev@example.invalid');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('autoWork', 'true');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('agentExecutionMode', 'safe');

  const settings = getSettings();
  assert.equal('ngrokUrl' in settings, false);
  assert.equal(settings.jiraBaseUrl, 'https://jira.example.invalid');
  assert.equal(settings.jiraEmail, 'dev@example.invalid');
  assert.equal(settings.autoWork, true);
  assert.equal(settings.agentExecutionMode, 'safe');
});

test('saveSettings never writes or rewrites legacy ngrokUrl data', () => {
  const legacy = 'https://legacy-ngrok.example.invalid';
  insertLegacyNgrokUrl(legacy);

  const result = saveSettings({
    jiraBaseUrl: 'https://jira-updated.example.invalid',
    jiraEmail: 'updated@example.invalid',
    autoWork: false,
    agentExecutionMode: 'full',
  });

  assert.equal('ngrokUrl' in result, false);
  assert.equal(readStoredValue('ngrokUrl'), legacy);
  assert.equal(readStoredValue('jiraBaseUrl'), 'https://jira-updated.example.invalid');
  assert.equal(readStoredValue('jiraEmail'), 'updated@example.invalid');
  assert.equal(readStoredValue('autoWork'), 'false');
  assert.equal(readStoredValue('agentExecutionMode'), 'full');
});

test('GET /api/settings omits ngrokUrl even when a legacy row exists', async () => {
  insertLegacyNgrokUrl('https://legacy-ngrok.example.invalid');
  saveSettings({ jiraBaseUrl: 'https://jira.example.invalid', jiraEmail: 'dev@example.invalid' });

  await withSettingsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.equal(Object.prototype.hasOwnProperty.call(body, 'ngrokUrl'), false);
    assert.equal(body.jiraBaseUrl, 'https://jira.example.invalid');
    assert.equal(body.jiraEmail, 'dev@example.invalid');
    assert.equal(typeof body.githubTokenMasked, 'boolean');
    assert.equal(typeof body.jiraTokenMasked, 'boolean');
    assert.equal(typeof body.figmaTokenMasked, 'boolean');
  });
});

test('POST /api/settings ignores ngrokUrl input and preserves unrelated settings writes', async () => {
  const legacy = 'https://legacy-ngrok.example.invalid';
  insertLegacyNgrokUrl(legacy);

  await withSettingsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ngrokUrl: 'https://must-not-be-saved.example.invalid',
        jiraBaseUrl: 'https://jira-post.example.invalid',
        jiraEmail: 'post@example.invalid',
        agentExecutionMode: 'safe',
      }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(readStoredValue('ngrokUrl'), legacy);
    assert.equal(readStoredValue('jiraBaseUrl'), 'https://jira-post.example.invalid');
    assert.equal(readStoredValue('jiraEmail'), 'post@example.invalid');
    assert.equal(readStoredValue('agentExecutionMode'), 'safe');

    const getResponse = await fetch(`${baseUrl}/api/settings`);
    const getBody = await getResponse.json() as Record<string, unknown>;
    assert.equal(Object.prototype.hasOwnProperty.call(getBody, 'ngrokUrl'), false);
  });
});

test('POST /api/settings no longer validates ngrokUrl as an active field', async () => {
  insertLegacyNgrokUrl('legacy-value');

  await withSettingsServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ngrokUrl: { obsolete: true }, jiraEmail: 'still-valid@example.invalid' }),
    });
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.success, true);
    assert.equal(readStoredValue('ngrokUrl'), 'legacy-value');
    assert.equal(readStoredValue('jiraEmail'), 'still-valid@example.invalid');
  });
});
