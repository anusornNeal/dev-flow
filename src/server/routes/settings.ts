import type express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveSettings } from '../repositories/settingsRepository';

export function registerSettingsRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/settings', (_req, res) => {
    res.json({
      ngrokUrl: deps.state.settingsCache.ngrokUrl ?? '',
      githubTokenMasked: (deps.state.settingsCache.githubToken?.length ?? 0) > 0,
      jiraTokenMasked: (deps.state.settingsCache.jiraToken?.length ?? 0) > 0,
    });
  });

  app.post('/api/settings', (req, res) => {
    const { ngrokUrl, githubToken, jiraToken } = req.body;

    // Validate types
    if (ngrokUrl !== undefined && typeof ngrokUrl !== 'string') {
      return res.status(400).json({ error: 'ngrokUrl must be a string' });
    }
    if (githubToken !== undefined && typeof githubToken !== 'string') {
      return res.status(400).json({ error: 'githubToken must be a string' });
    }
    if (jiraToken !== undefined && typeof jiraToken !== 'string') {
      return res.status(400).json({ error: 'jiraToken must be a string' });
    }

    if (typeof ngrokUrl === 'string') {
      deps.state.settingsCache.ngrokUrl = ngrokUrl.trim();
    }

    if (typeof githubToken === 'string') {
      deps.state.settingsCache.githubToken = githubToken;
    }

    if (typeof jiraToken === 'string') {
      deps.state.settingsCache.jiraToken = jiraToken;
    }

    saveSettings(deps.state);
    return res.json({ success: true });
  });
}
