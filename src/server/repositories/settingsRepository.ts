import db from '../../db/index';
import type { AppState } from '../types';

const SETTING_KEYS = ['autoWorking', 'ngrokUrl', 'envNotes'] as const;

export function loadSettings(state: AppState) {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map(rows.map(r => [r.key, r.value]));

  const autoWorkingRaw = map.get('autoWorking');
  const autoWorking = autoWorkingRaw !== undefined ? JSON.parse(autoWorkingRaw) : false;
  const ngrokUrl = map.get('ngrokUrl') ?? '';
  const envNotes = map.get('envNotes') ?? '';

  state.settingsCache = { autoWorking, ngrokUrl, envNotes };
}

export function saveSettings(state: AppState) {
  const stmt = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  db.transaction(() => {
    stmt.run('autoWorking', JSON.stringify(state.settingsCache.autoWorking));
    stmt.run('ngrokUrl', state.settingsCache.ngrokUrl ?? '');
    stmt.run('envNotes', state.settingsCache.envNotes ?? '');
  })();
}
