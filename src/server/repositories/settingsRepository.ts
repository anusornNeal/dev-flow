import db from '../../db/index';
import type { AppState } from '../types';

export function loadSettings(state: AppState) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('autoWorking') as { value?: string } | undefined;
  if (row && row.value) {
    try {
      state.settingsCache = { autoWorking: JSON.parse(row.value) };
    } catch {
      state.settingsCache = { autoWorking: false };
    }
  } else {
    saveSettings(state);
  }
}

export function saveSettings(state: AppState) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('autoWorking', JSON.stringify(state.settingsCache.autoWorking));
}
