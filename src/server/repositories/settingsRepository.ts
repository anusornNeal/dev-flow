import db from '../../db/index';
import type { AppState } from '../types';

const SETTING_KEYS = ['ngrokUrl', 'githubToken', 'jiraToken'] as const;

export function loadSettings(state: AppState) {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map(r => [r.key, r.value]));

  const ngrokUrl = map.get('ngrokUrl') ?? '';
  const githubToken = map.get('githubToken') ?? '';
  const jiraToken = map.get('jiraToken') ?? '';

  state.settingsCache = { ngrokUrl, githubToken, jiraToken };
}

export function saveSettings(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('ngrokUrl', state.settingsCache.ngrokUrl ?? '');
    stmt.run('githubToken', state.settingsCache.githubToken ?? '');
    stmt.run('jiraToken', state.settingsCache.jiraToken ?? '');
  })();
}
