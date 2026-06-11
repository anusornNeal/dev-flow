import express from 'express';
import type { ApiRouteDeps } from '../types';
import { registerProjectRoutes } from './projects';
import { registerSettingsRoutes } from './settings';
import { registerSkillRoutes } from './skills';
import { registerTaskRoutes } from './tasks';

export function registerApiRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.use('/api', express.json({ limit: '50mb' }));
  registerSkillRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerTaskRoutes(app, deps);
}
