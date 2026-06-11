import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveSettings } from '../repositories/settingsRepository';

export function registerSettingsRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/settings', (_req, res) => {
    res.json(deps.state.settingsCache);
  });

  app.post('/api/settings', (req, res) => {
    const { autoWorking } = req.body;
    if (typeof autoWorking === 'boolean') {
      const wasOff = !deps.state.settingsCache.autoWorking;
      deps.state.settingsCache.autoWorking = autoWorking;
      saveSettings(deps.state);

      if (wasOff && autoWorking) {
        deps.writeAgentLog('INFO', 'Auto-work enabled. Scanning for queued ready-to-do tasks...');
        deps.drainReadyToDoQueue();
      }
    }
    res.json(deps.state.settingsCache);
  });
}
