import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-settings-security-'));
process.env.DEVFLOW_DB_PATH = path.join(tempDir, 'devflow.db');
process.env.DEVFLOW_CREDENTIAL_VAULT_PATH = path.join(tempDir, 'credentials.vault.json');

delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
delete process.env.JIRA_API_TOKEN;
delete process.env.JIRA_PERSONAL_ACCESS_TOKEN;
delete process.env.FIGMA_ACCESS_TOKEN;
delete process.env.FIGMA_PERSONAL_ACCESS_TOKEN;

const vault = await import('../../src/server/services/credentialVaultService.js');
const access = await import('../../src/server/services/apiAccessPolicyService.js');
const db = (await import('../../src/db/index.js')).default;
const { executeAllMigrations } = await import('../../src/db/migrations/index.js');
executeAllMigrations();

const provider = vault.createMemoryCredentialVaultProvider();
vault.setCredentialVaultProviderForTests(provider);
const settingsRepository = await import('../../src/server/repositories/settingsRepository.js');

test('environment variables override persisted vault credentials without being persisted', () => {
  vault.setCredential('githubToken', 'vault-github-token');
  process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'env-github-token';

  assert.equal(vault.getCredential('githubToken'), 'env-github-token');
  delete process.env.GITHUB_PERSONAL_ACCESS_TOKEN;
  assert.equal(vault.getCredential('githubToken'), 'vault-github-token');
});

test('legacy plaintext integration tokens migrate to the vault and are cleared from SQLite', () => {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('jiraToken', 'legacy-jira-token');
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('figmaToken', 'legacy-figma-token');

  const settings = settingsRepository.getSettings();
  assert.equal(settings.jiraToken, 'legacy-jira-token');
  assert.equal(settings.figmaToken, 'legacy-figma-token');

  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('githubToken', 'jiraToken', 'figmaToken')").all() as Array<{ key: string; value: string }>;
  assert.ok(rows.every((row) => row.value === ''), JSON.stringify(rows));
  assert.equal(vault.getCredential('jiraToken'), 'legacy-jira-token');
  assert.equal(vault.getCredential('figmaToken'), 'legacy-figma-token');
});

test('saving integration tokens stores secrets in the vault and leaves SQLite secret rows blank', () => {
  settingsRepository.saveSettings({ githubToken: 'new-github-token', jiraToken: 'new-jira-token' });

  assert.equal(vault.getCredential('githubToken'), 'new-github-token');
  assert.equal(vault.getCredential('jiraToken'), 'new-jira-token');
  const rows = db.prepare("SELECT key, value FROM settings WHERE key IN ('githubToken', 'jiraToken', 'figmaToken')").all() as Array<{ key: string; value: string }>;
  assert.ok(rows.every((row) => row.value === ''), JSON.stringify(rows));
});

test('macOS credential provider uses Keychain without shell execution', () => {
  const values = new Map<string, string>();
  const calls: Array<{ command: string; args: string[]; options: any }> = [];
  const fakeSecurity = ((command: string, args: string[], options: any) => {
    calls.push({ command, args: [...args], options });
    if (args[0] === 'list-keychains') return { status: 0, stdout: 'login.keychain-db\n', stderr: '' } as any;
    const service = args[args.indexOf('-s') + 1];
    if (args[0] === 'add-generic-password') {
      values.set(service, args[args.indexOf('-w') + 1]);
      return { status: 0, stdout: '', stderr: '' } as any;
    }
    if (args[0] === 'find-generic-password') {
      return values.has(service)
        ? { status: 0, stdout: `${values.get(service)}\n`, stderr: '' } as any
        : { status: 44, stdout: '', stderr: 'not found' } as any;
    }
    if (args[0] === 'delete-generic-password') {
      values.delete(service);
      return { status: 0, stdout: '', stderr: '' } as any;
    }
    return { status: 1, stdout: '', stderr: 'unexpected command' } as any;
  }) as any;

  const first = new vault.MacOSKeychainCredentialVaultProvider('darwin', fakeSecurity);
  assert.equal(first.name, 'macos-keychain');
  assert.equal(first.isAvailable(), true);
  first.set('githubToken', 'mac-keychain-secret');
  const second = new vault.MacOSKeychainCredentialVaultProvider('darwin', fakeSecurity);
  assert.equal(second.get('githubToken'), 'mac-keychain-secret');
  second.delete('githubToken');
  assert.equal(new vault.MacOSKeychainCredentialVaultProvider('darwin', fakeSecurity).get('githubToken'), '');
  assert.ok(calls.every((call) => call.command === '/usr/bin/security'));
  assert.ok(calls.every((call) => call.options?.shell === false));
  assert.equal(new vault.MacOSKeychainCredentialVaultProvider('win32', fakeSecurity).isAvailable(), false);
});

test('credential persistence fails closed when no secure provider is available', () => {
  vault.setCredentialVaultProviderForTests(vault.createUnavailableCredentialVaultProvider('test-unavailable'));
  assert.throws(() => vault.setCredential('githubToken', 'must-not-persist'), /secure credential storage is unavailable/i);
  vault.setCredentialVaultProviderForTests(provider);
});

test('API access policy trusts direct loopback mutations but rejects forwarded remote mutations by default', () => {
  const local = access.evaluateApiAccessPolicy({ method: 'POST', remoteAddress: '127.0.0.1' });
  assert.equal(local.allowed, true);
  assert.equal(local.trust, 'local');

  const remote = access.evaluateApiAccessPolicy({ method: 'POST', remoteAddress: '127.0.0.1', forwardedFor: '203.0.113.9' });
  assert.equal(remote.allowed, false);
  assert.equal(remote.code, 'REMOTE_API_AUTH_REQUIRED');
});

test('remote API mutations require an explicitly configured matching authorization token', () => {
  const denied = access.evaluateApiAccessPolicy({
    method: 'PATCH',
    remoteAddress: '10.0.0.5',
    configuredRemoteToken: 'configured-token',
    authorization: 'Bearer wrong-token',
  });
  assert.equal(denied.allowed, false);
  assert.equal(denied.code, 'REMOTE_API_AUTH_INVALID');

  const allowed = access.evaluateApiAccessPolicy({
    method: 'PATCH',
    remoteAddress: '10.0.0.5',
    configuredRemoteToken: 'configured-token',
    authorization: 'Bearer configured-token',
  });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.trust, 'trusted-remote');
});

test('read-only remote API requests remain available without privileged authorization', () => {
  const result = access.evaluateApiAccessPolicy({ method: 'GET', remoteAddress: '10.0.0.5' });
  assert.equal(result.allowed, true);
  assert.equal(result.trust, 'remote-readonly');
});

test('strict UI preview access rejects remote or mixed forwarded chains while accepting loopback forms', () => {
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1' }).allowed, true);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '::1' }).allowed, true);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '::ffff:127.0.0.7' }).allowed, true);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '10.0.0.5' }).allowed, false);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwardedFor: '127.0.0.2, 203.0.113.9' }).allowed, false);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwarded: 'for=127.0.0.2, for="[::1]"' }).allowed, true);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwarded: 'for=_hidden' }).allowed, false);
  assert.equal(access.evaluateStrictLoopbackAccess({ remoteAddress: '127.0.0.1', forwardedFor: '127.999.0.1' }).allowed, false);
});

test('redaction removes configured credential values from diagnostic text', () => {
  const text = vault.redactCredentialText('failure github=gh-secret jira=jr-secret', ['gh-secret', 'jr-secret']);
  assert.equal(text.includes('gh-secret'), false);
  assert.equal(text.includes('jr-secret'), false);
  assert.match(text, /\[REDACTED\]/);
});

test('privileged API middleware rejects tunneled mutations unless the remote token matches', async () => {
  const express = (await import('express')).default;
  const http = await import('node:http');
  const app = express();
  app.use('/api', access.createPrivilegedApiAccessMiddleware());
  app.post('/api/mutate', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    delete process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
    const denied = await fetch(`${baseUrl}/api/mutate`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '203.0.113.25' },
    });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as any).code, 'REMOTE_API_AUTH_REQUIRED');

    process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN = 'remote-secret';
    const allowed = await fetch(`${baseUrl}/api/mutate`, {
      method: 'POST',
      headers: {
        'x-forwarded-for': '203.0.113.25',
        authorization: 'Bearer remote-secret',
      },
    });
    assert.equal(allowed.status, 200);
  } finally {
    delete process.env.DEVFLOW_TRUSTED_REMOTE_TOKEN;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('settings API exposes masked state only and clear flags remove vault credentials', async () => {
  const express = (await import('express')).default;
  const http = await import('node:http');
  const { registerSettingsRoutes } = await import('../../src/server/routes/settings.js');
  vault.setCredentialVaultProviderForTests(provider);
  vault.setCredential('githubToken', 'route-github-secret');

  const app = express();
  app.use(express.json());
  registerSettingsRoutes(app, { state: { countersCache: {} }, writeAgentLog: () => {} });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  try {
    const before = await fetch(`${baseUrl}/api/settings`);
    const body = await before.json() as any;
    assert.equal(body.githubTokenMasked, true);
    assert.equal(body.githubToken, undefined);
    assert.equal(JSON.stringify(body).includes('route-github-secret'), false);
    assert.equal(body.credentialVault.provider, 'memory');

    const cleared = await fetch(`${baseUrl}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clearGithubToken: true }),
    });
    assert.equal(cleared.status, 200);
    assert.equal(vault.getCredential('githubToken'), '');

    const after = await fetch(`${baseUrl}/api/settings`);
    assert.equal((await after.json() as any).githubTokenMasked, false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('MCP job persistence redacts credential values from args logs and results', async () => {
  vault.setCredentialVaultProviderForTests(provider);
  vault.setCredential('githubToken', 'job-secret-value');
  const jobs = await import('../../src/server/repositories/mcpToolJobRepository.js');
  const jobId = `security-redaction-${Date.now()}`;

  const created = jobs.createJob(jobId, 'security-test', {
    githubToken: 'job-secret-value',
    message: 'payload contains job-secret-value',
  }, 'security-resource');
  assert.equal(JSON.stringify(created).includes('job-secret-value'), false);

  jobs.appendJobLog(jobId, 'stdout', 'log contains job-secret-value');
  jobs.writeJobResult(jobId, {
    message: 'result contains job-secret-value',
    nested: { authorization: 'job-secret-value' },
  });

  assert.equal(jobs.readJobLog(jobId, 'stdout').log.includes('job-secret-value'), false);
  assert.equal(JSON.stringify(jobs.readJobResult(jobId)).includes('job-secret-value'), false);
});

test.after(() => {
  vault.resetCredentialVaultProviderForTests();
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {}
});
