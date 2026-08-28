import db from '../../db/index.js';
import { publishServerEvent } from '../services/serverEventService.js';
import { deleteCredential, getCredential, getStoredCredential, migrateLegacyCredentials, setCredential, type CredentialKey } from '../services/credentialVaultService.js';

const SECRET_SETTING_KEYS: CredentialKey[] = ['githubToken', 'jiraToken', 'figmaToken', 'openAiRuntimeApiKey'];

function readSettingsMap() {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  return new Map(rows.map((row) => [row.key, row.value]));
}

function migrateLegacySecretSettings(map: Map<string, string>) {
  const legacy = Object.fromEntries(SECRET_SETTING_KEYS.map((key) => [key, map.get(key) || ''])) as Partial<Record<CredentialKey, string>>;
  const result = migrateLegacyCredentials(legacy);
  if (result.migrated.length === 0) return result;

  const clear = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    for (const key of result.migrated) {
      clear.run(key, '');
      map.set(key, '');
    }
  })();
  return result;
}

function resolveCredentialWithLegacyFallback(key: CredentialKey, map: Map<string, string>) {
  return getCredential(key) || map.get(key) || '';
}

export function getSettings() {
  const map = readSettingsMap();
  migrateLegacySecretSettings(map);

  const githubToken = resolveCredentialWithLegacyFallback('githubToken', map);
  const jiraToken = resolveCredentialWithLegacyFallback('jiraToken', map);
  const figmaToken = resolveCredentialWithLegacyFallback('figmaToken', map);
  const openAiRuntimeApiKey = getStoredCredential('openAiRuntimeApiKey') || resolveCredentialWithLegacyFallback('openAiRuntimeApiKey', map);
  const openAiTunnelId = map.get('openAiTunnelId') || '';
  const jiraBaseUrl = map.get('jiraBaseUrl') || process.env.JIRA_BASE_URL || '';
  const jiraEmail = map.get('jiraEmail') || process.env.JIRA_EMAIL || '';
  const autoWork = map.get('autoWork') === 'true';
  const agentExecutionMode = map.get('agentExecutionMode') || '';

  return { githubToken, jiraToken, figmaToken, openAiRuntimeApiKey, openAiTunnelId, jiraBaseUrl, jiraEmail, autoWork, agentExecutionMode };
}

export function saveSettings(settings: Partial<ReturnType<typeof getSettings>>) {
  const current = getSettings();
  const updated = { ...current, ...settings };
  const changedSecretKeys = SECRET_SETTING_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(settings, key));

  for (const key of changedSecretKeys) {
    const value = String(settings[key] || '').trim();
    if (value) setCredential(key, value);
    else deleteCredential(key);
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('openAiTunnelId', updated.openAiTunnelId ?? '');
    stmt.run('jiraBaseUrl', updated.jiraBaseUrl ?? '');
    stmt.run('jiraEmail', updated.jiraEmail ?? '');
    stmt.run('autoWork', updated.autoWork ? 'true' : 'false');
    stmt.run('agentExecutionMode', updated.agentExecutionMode ?? '');
    for (const key of changedSecretKeys) stmt.run(key, '');
  })();
  publishServerEvent('settings.changed', { reason: 'saved' });
  return getSettings();
}
