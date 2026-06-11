import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveSettings } from '../repositories/settingsRepository';

export function registerSettingsRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/settings', (_req, res) => {
    res.json({
      autoWorking: deps.state.settingsCache.autoWorking,
      ngrokUrl: deps.state.settingsCache.ngrokUrl ?? '',
      // envNotes is returned masked: we only tell the frontend if it's set, not the value
      envNotesMasked: (deps.state.settingsCache.envNotes?.length ?? 0) > 0,
      envNotesLength: deps.state.settingsCache.envNotes?.length ?? 0,
    });
  });

  app.post('/api/settings', (req, res) => {
    const { autoWorking, ngrokUrl, envNotes } = req.body;

    // Validate types
    if (autoWorking !== undefined && typeof autoWorking !== 'boolean') {
      return res.status(400).json({ error: 'autoWorking must be a boolean' });
    }
    if (ngrokUrl !== undefined && typeof ngrokUrl !== 'string') {
      return res.status(400).json({ error: 'ngrokUrl must be a string' });
    }
    if (envNotes !== undefined && typeof envNotes !== 'string') {
      return res.status(400).json({ error: 'envNotes must be a string' });
    }

    if (typeof autoWorking === 'boolean') {
      const wasOff = !deps.state.settingsCache.autoWorking;
      deps.state.settingsCache.autoWorking = autoWorking;
      if (wasOff && autoWorking) {
        deps.writeAgentLog('INFO', 'Auto-work enabled. Scanning for queued ready-to-do tasks...');
        deps.drainReadyToDoQueue();
      }
    }

    if (typeof ngrokUrl === 'string') {
      deps.state.settingsCache.ngrokUrl = ngrokUrl.trim();
    }

    if (typeof envNotes === 'string') {
      deps.state.settingsCache.envNotes = envNotes;
    }

    saveSettings(deps.state);
    return res.json({ success: true });
  });
}
