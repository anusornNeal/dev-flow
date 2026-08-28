import express from 'express';
import type { ApiRouteDeps } from '../types';
import { installApiRequestContext } from '../services/api';
import { registerDevFlowRoutes } from './devflow';
import { registerProjectRoutes } from './projects';
import { registerPromptOverrideRoutes } from './prompts';
import { registerSettingsRoutes } from './settings';
import { registerSkillRoutes } from './skills';
import { registerTaskRoutes } from './tasks';
import { registerAttachmentRoutes } from './attachments';
import { registerFigmaRoutes } from './figma';
import { registerMcpToolJobRoutes } from './mcpToolJobs';
import { registerEventRoutes } from './events';
import { registerExecutionSessionRoutes } from './executionSessions';
import { registerUiPreviewRoutes } from './uiPreviews';
import { registerChatSessionRoutes } from './chatSessions';
import { initMcpToolJobs } from '../services/mcpToolJobService';
import { createPrivilegedApiAccessMiddleware } from '../services/apiAccessPolicyService';

export function registerApiRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.use('/api', express.json({ limit: '50mb' }));
  installApiRequestContext(app);
  app.use('/api', createPrivilegedApiAccessMiddleware());
  registerEventRoutes(app);
  registerDevFlowRoutes(app, deps);
  registerExecutionSessionRoutes(app, deps);
  registerChatSessionRoutes(app, deps);
  registerSkillRoutes(app, deps);
  registerProjectRoutes(app, deps);
  registerSettingsRoutes(app, deps);
  registerTaskRoutes(app, deps);
  registerUiPreviewRoutes(app, deps);
  registerAttachmentRoutes(app, deps);
  registerPromptOverrideRoutes(app, deps);
  registerFigmaRoutes(app, deps);
  registerMcpToolJobRoutes(app, deps);

  initMcpToolJobs(deps.state);
}
