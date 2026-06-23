import db from '../../db/index.js';

const SETTING_KEYS = ['ngrokUrl', 'githubToken', 'jiraToken', 'figmaToken'] as const;

export function getSettings() {
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

  return { ngrokUrl, githubToken, jiraToken, figmaToken, jiraBaseUrl, jiraEmail, autoWork, agentExecutionMode };
}

export function saveSettings(settings: Partial<ReturnType<typeof getSettings>>) {
  const current = getSettings();
  const updated = { ...current, ...settings };

  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('ngrokUrl', updated.ngrokUrl ?? '');
    stmt.run('githubToken', updated.githubToken ?? '');
    stmt.run('jiraToken', updated.jiraToken ?? '');
    stmt.run('figmaToken', updated.figmaToken ?? '');
    stmt.run('jiraBaseUrl', updated.jiraBaseUrl ?? '');
    stmt.run('jiraEmail', updated.jiraEmail ?? '');
    stmt.run('autoWork', updated.autoWork ? 'true' : 'false');
    stmt.run('agentExecutionMode', updated.agentExecutionMode ?? '');
  })();
  return updated;
}
