import db from '../../db/index';
import type { AppState } from '../types';

const SETTING_KEYS = ['ngrokUrl', 'githubToken', 'jiraToken', 'figmaToken'] as const;

export function loadSettings(state: AppState) {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map(r => [r.key, r.value]));

  const ngrokUrl = map.get('ngrokUrl') ?? '';
  const githubToken = map.get('githubToken') || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '';
  const jiraToken = map.get('jiraToken') || process.env.JIRA_API_TOKEN || process.env.JIRA_PERSONAL_ACCESS_TOKEN || '';
  const figmaToken = map.get('figmaToken') || process.env.FIGMA_ACCESS_TOKEN || process.env.FIGMA_PERSONAL_ACCESS_TOKEN || '';
  const jiraBaseUrl = map.get('jiraBaseUrl') || process.env.JIRA_BASE_URL || '';
  const jiraEmail = map.get('jiraEmail') || process.env.JIRA_EMAIL || '';
  const autoWork = map.get('autoWork') === 'true';
  const agentExecutionMode = map.get('agentExecutionMode') || '';

  state.settingsCache = { ngrokUrl, githubToken, jiraToken, figmaToken, jiraBaseUrl, jiraEmail, autoWork, agentExecutionMode };
}

export function saveSettings(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('ngrokUrl', state.settingsCache.ngrokUrl ?? '');
    stmt.run('githubToken', state.settingsCache.githubToken ?? '');
    stmt.run('jiraToken', state.settingsCache.jiraToken ?? '');
    stmt.run('figmaToken', state.settingsCache.figmaToken ?? '');
    stmt.run('jiraBaseUrl', state.settingsCache.jiraBaseUrl ?? '');
    stmt.run('jiraEmail', state.settingsCache.jiraEmail ?? '');
    stmt.run('autoWork', state.settingsCache.autoWork ? 'true' : 'false');
    stmt.run('agentExecutionMode', state.settingsCache.agentExecutionMode ?? '');
  })();
}
