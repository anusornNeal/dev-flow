import express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveSettings } from '../repositories/settingsRepository';
import fs from 'fs';
import path from 'path';
import db from '../../db/index';
import Database from 'better-sqlite3';
import { runAgentLaunchPreflight } from '../services/agentLaunchConfig';
import { resolveAgentExecutionMode, resolveFromDevFlowAppRoot } from '../services/agentRunService';

function validateAutoWorkConfiguration(deps: ApiRouteDeps) {
  const queuedTasks = deps.state.tasksCache
    .filter((task) => task.status === 'todo' && task.agent)
    .sort((left, right) => new Date(left.createdAt || 0).getTime() - new Date(right.createdAt || 0).getTime());

  const executionMode = resolveAgentExecutionMode(deps.state.settingsCache.agentExecutionMode || process.env.DEVFLOW_AGENT_EXECUTION_MODE);
  for (const task of queuedTasks) {
    const project = deps.state.projectsCache.find((entry) => entry.id === task.projectId);
    const preflight = runAgentLaunchPreflight({
      agent: task.agent,
      localPath: project?.localPath,
      model: task.model,
      effort: task.effort,
      executionMode,
      appRoot: resolveFromDevFlowAppRoot(),
    });

    if (!preflight.ok) {
      const displayId = task.displayId || task.id;
      return {
        ok: false,
        error: `Auto Work cannot be enabled because ${displayId} is not launch-ready: ${preflight.message}`,
        code: 'AUTO_WORK_CONFIG_INVALID',
        taskId: task.id,
        displayId,
        preflightCode: preflight.code,
      };
    }
  }

  return { ok: true };
}

export function registerSettingsRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/settings', (_req, res) => {
    res.json({
      ngrokUrl: deps.state.settingsCache.ngrokUrl ?? '',
      githubTokenMasked: (deps.state.settingsCache.githubToken?.length ?? 0) > 0,
      jiraTokenMasked: (deps.state.settingsCache.jiraToken?.length ?? 0) > 0,
      jiraBaseUrl: deps.state.settingsCache.jiraBaseUrl ?? '',
      jiraEmail: deps.state.settingsCache.jiraEmail ?? '',
      autoWork: deps.state.settingsCache.autoWork ?? false,
      agentExecutionMode: deps.state.settingsCache.agentExecutionMode ?? '',
    });
  });

  app.post('/api/settings', (req, res) => {
    console.log('--- POST /api/settings PAYLOAD ---', JSON.stringify(req.body));
    const { ngrokUrl, githubToken, jiraToken, jiraBaseUrl, jiraEmail, autoWork, agentExecutionMode, clearGithubToken, clearJiraToken } = req.body;

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
    if (jiraBaseUrl !== undefined && typeof jiraBaseUrl !== 'string') {
      return res.status(400).json({ error: 'jiraBaseUrl must be a string' });
    }
    if (jiraEmail !== undefined && typeof jiraEmail !== 'string') {
      return res.status(400).json({ error: 'jiraEmail must be a string' });
    }
    if (autoWork !== undefined && typeof autoWork !== 'boolean') {
      return res.status(400).json({ error: 'autoWork must be a boolean' });
    }
    if (agentExecutionMode !== undefined && typeof agentExecutionMode !== 'string') {
      return res.status(400).json({ error: 'agentExecutionMode must be a string' });
    }
    if (agentExecutionMode !== undefined && agentExecutionMode !== '' && agentExecutionMode !== 'safe' && agentExecutionMode !== 'full') {
      return res.status(400).json({ error: 'agentExecutionMode must be safe or full' });
    }
    if (clearGithubToken !== undefined && typeof clearGithubToken !== 'boolean') {
      return res.status(400).json({ error: 'clearGithubToken must be a boolean' });
    }
    if (clearJiraToken !== undefined && typeof clearJiraToken !== 'boolean') {
      return res.status(400).json({ error: 'clearJiraToken must be a boolean' });
    }

    if (typeof ngrokUrl === 'string') {
      deps.state.settingsCache.ngrokUrl = ngrokUrl.trim();
    }

    if (typeof githubToken === 'string') {
      deps.state.settingsCache.githubToken = githubToken.trim();
    }

    if (typeof jiraToken === 'string') {
      deps.state.settingsCache.jiraToken = jiraToken.trim();
    }

    if (typeof jiraBaseUrl === 'string') {
      deps.state.settingsCache.jiraBaseUrl = jiraBaseUrl.trim();
    }

    if (typeof jiraEmail === 'string') {
      deps.state.settingsCache.jiraEmail = jiraEmail.trim();
    }

    if (typeof autoWork === 'boolean') {
      if (autoWork) {
        const validation = validateAutoWorkConfiguration(deps);
        if (!validation.ok) {
          return res.status(409).json(validation);
        }
      }
      deps.state.settingsCache.autoWork = autoWork;
    }

    if (typeof agentExecutionMode === 'string') {
      deps.state.settingsCache.agentExecutionMode = agentExecutionMode;
    }

    saveSettings(deps.state);
    return res.json({ success: true });
  });

  app.get('/api/export', async (_req, res) => {
    try {
      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tempFile = path.join(dataDir, `devflow-export-temp-${timestamp}.db`);
      const exportFilename = `devflow-backup-${timestamp}.db`;

      // Perform a safe live backup
      await db.backup(tempFile);

      // Open the temp database to strip secrets
      const tempDb = new Database(tempFile);
      try {
        tempDb.prepare("UPDATE settings SET value = '' WHERE key IN ('githubToken', 'jiraToken')").run();
      } finally {
        tempDb.close();
      }

      // Send file to client
      res.download(tempFile, exportFilename, (err) => {
        // Clean up the temp file after download finishes or errors
        if (fs.existsSync(tempFile)) {
          try {
            fs.unlinkSync(tempFile);
          } catch (unlinkErr) {
            console.error('Failed to clean up temp export file:', unlinkErr);
          }
        }
        if (err) {
          console.error('Export download error:', err);
          // Only send error if headers aren't sent yet
          if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to send export file' });
          }
        }
      });
    } catch (error: any) {
      console.error('Export failed:', error);
      res.status(500).json({ error: error.message ?? 'Export failed' });
    }
  });

  app.post('/api/import', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'Invalid file payload' });
      }

      const dataDir = path.join(process.cwd(), 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tempFile = path.join(dataDir, `devflow-import-temp-${timestamp}.db`);
      const safetyBackup = path.join(dataDir, `devflow-safety-${timestamp}.db`);
      const targetDbFile = path.join(dataDir, 'devflow.db');

      // 1. Save uploaded file to temp path
      fs.writeFileSync(tempFile, req.body);

      // 2. Validate the uploaded database and get row counts
      let isValid = false;
      const counts: Record<string, number> = {};
      try {
        const tempDb = new Database(tempFile);
        
        // Check for required tables
        const requiredTables = ['projects', 'tasks', 'settings', 'skills', 'counters'];
        const tables = tempDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
        const tableNames = tables.map(t => t.name);
        
        isValid = requiredTables.every(t => tableNames.includes(t));
        
        if (isValid) {
          counts.projects = (tempDb.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
          counts.tasks = (tempDb.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number }).c;
          counts.skills = (tempDb.prepare('SELECT COUNT(*) AS c FROM skills').get() as { c: number }).c;
          counts.settings = (tempDb.prepare('SELECT COUNT(*) AS c FROM settings').get() as { c: number }).c;
          counts.agent_runs = (tempDb.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='agent_runs'").get() as { c: number }).c > 0
            ? (tempDb.prepare('SELECT COUNT(*) AS c FROM agent_runs').get() as { c: number }).c
            : 0;
        }
        tempDb.close();
      } catch (err) {
        console.error('Validation failed:', err);
        isValid = false;
      }

      if (!isValid) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return res.status(400).json({ error: 'Invalid DevFlow database file. Required tables are missing or file is corrupted.' });
      }

      // 3. Create safety backup of current DB
      if (fs.existsSync(targetDbFile)) {
        await db.backup(safetyBackup);
      }

      // 4. Safely replace current DB
      // Close active connection to release locks
      try { db.close(); } catch (e) { /* ignore */ }
      
      fs.copyFileSync(tempFile, targetDbFile);
      
      // Remove stale WAL and SHM files
      const walFile = targetDbFile + '-wal';
      const shmFile = targetDbFile + '-shm';
      if (fs.existsSync(walFile)) fs.unlinkSync(walFile);
      if (fs.existsSync(shmFile)) fs.unlinkSync(shmFile);

      // Clean up temp file
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);

      res.json({
        success: true,
        restartRequired: true,
        safetyBackupPath: safetyBackup,
        counts
      });
    } catch (error: any) {
      console.error('Import failed:', error);
      res.status(500).json({ error: error.message ?? 'Import failed' });
    }
  });
}
