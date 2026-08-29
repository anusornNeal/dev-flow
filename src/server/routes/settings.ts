import express from 'express';
import type { ApiRouteDeps } from '../types';
import { saveSettings, getSettings } from '../repositories/settingsRepository.js';
import fs from 'fs';
import path from 'path';
import db from '../../db/index';
import { getDevFlowDataDir, getDevFlowDbPath, resolveFromDevFlowAppRoot } from '../../lib/devFlowPaths';
import { getCredentialVaultDiagnostics } from '../services/credentialVaultService';
import { createVerifiedBackupSnapshot, getRecoveryStatus, runLatestRestoreDrill, verifyBackupFile } from '../services/backupIntegrityService';

function persistSettingsOrRespond(res: express.Response, settings: Partial<Parameters<typeof saveSettings>[0]>) {
  try {
    saveSettings(settings);
    return true;
  } catch {
    res.status(503).json({
      error: 'Settings could not be saved securely. Configure a supported credential vault or use environment variables.',
      code: 'SETTINGS_SECURE_PERSISTENCE_FAILED',
      credentialVault: getCredentialVaultDiagnostics(),
    });
    return false;
  }
}

export function registerSettingsRoutes(app: express.Express, deps: ApiRouteDeps) {
  app.get('/api/settings', (_req, res) => {
    const settings = getSettings();
    res.json({
      githubTokenMasked: (settings.githubToken?.length ?? 0) > 0,
      jiraTokenMasked: (settings.jiraToken?.length ?? 0) > 0,
      figmaTokenMasked: (settings.figmaToken?.length ?? 0) > 0,
      openAiRuntimeApiKeyMasked: (settings.openAiRuntimeApiKey?.length ?? 0) > 0,
      openAiTunnelId: settings.openAiTunnelId ?? '',
      jiraBaseUrl: settings.jiraBaseUrl ?? '',
      jiraEmail: settings.jiraEmail ?? '',
      autoWork: false,
      credentialVault: getCredentialVaultDiagnostics(),
      recovery: getRecoveryStatus(),
    });
  });

  app.post('/api/settings', (req, res) => {
    const settings: Partial<Parameters<typeof saveSettings>[0]> = {};
    const { githubToken, jiraToken, figmaToken, openAiRuntimeApiKey, openAiTunnelId, jiraBaseUrl, jiraEmail, clearGithubToken, clearJiraToken, clearFigmaToken, clearOpenAiRuntimeApiKey } = req.body;

    // Validate types
    if (githubToken !== undefined && typeof githubToken !== 'string') {
      return res.status(400).json({ error: 'githubToken must be a string' });
    }
    if (jiraToken !== undefined && typeof jiraToken !== 'string') {
      return res.status(400).json({ error: 'jiraToken must be a string' });
    }
    if (figmaToken !== undefined && typeof figmaToken !== 'string') {
      return res.status(400).json({ error: 'figmaToken must be a string' });
    }
    if (openAiRuntimeApiKey !== undefined && typeof openAiRuntimeApiKey !== 'string') {
      return res.status(400).json({ error: 'openAiRuntimeApiKey must be a string' });
    }
    if (openAiTunnelId !== undefined && typeof openAiTunnelId !== 'string') {
      return res.status(400).json({ error: 'openAiTunnelId must be a string' });
    }
    if (typeof openAiTunnelId === 'string' && openAiTunnelId.trim() !== '' && !/^tunnel_[A-Za-z0-9_-]+$/.test(openAiTunnelId.trim())) {
      return res.status(400).json({ error: 'openAiTunnelId must start with "tunnel_" and contain only URL-safe identifier characters' });
    }
    if (jiraBaseUrl !== undefined && typeof jiraBaseUrl !== 'string') {
      return res.status(400).json({ error: 'jiraBaseUrl must be a string' });
    }
    if (jiraEmail !== undefined && typeof jiraEmail !== 'string') {
      return res.status(400).json({ error: 'jiraEmail must be a string' });
    }
    if (clearGithubToken !== undefined && typeof clearGithubToken !== 'boolean') {
      return res.status(400).json({ error: 'clearGithubToken must be a boolean' });
    }
    if (clearJiraToken !== undefined && typeof clearJiraToken !== 'boolean') {
      return res.status(400).json({ error: 'clearJiraToken must be a boolean' });
    }
    if (clearFigmaToken !== undefined && typeof clearFigmaToken !== 'boolean') {
      return res.status(400).json({ error: 'clearFigmaToken must be a boolean' });
    }
    if (clearOpenAiRuntimeApiKey !== undefined && typeof clearOpenAiRuntimeApiKey !== 'boolean') {
      return res.status(400).json({ error: 'clearOpenAiRuntimeApiKey must be a boolean' });
    }

    if (typeof githubToken === 'string') {
      settings.githubToken = githubToken.trim();
    }

    if (typeof jiraToken === 'string') {
      settings.jiraToken = jiraToken.trim();
    }

    if (typeof figmaToken === 'string') {
      settings.figmaToken = figmaToken.trim();
    }

    if (typeof openAiRuntimeApiKey === 'string') {
      settings.openAiRuntimeApiKey = openAiRuntimeApiKey.trim();
    }

    if (typeof openAiTunnelId === 'string') {
      settings.openAiTunnelId = openAiTunnelId.trim();
    }

    if (clearGithubToken === true) settings.githubToken = '';
    if (clearJiraToken === true) settings.jiraToken = '';
    if (clearFigmaToken === true) settings.figmaToken = '';
    if (clearOpenAiRuntimeApiKey === true) settings.openAiRuntimeApiKey = '';

    if (typeof jiraBaseUrl === 'string') {
      settings.jiraBaseUrl = jiraBaseUrl.trim();
    }

    if (typeof jiraEmail === 'string') {
      settings.jiraEmail = jiraEmail.trim();
    }

    if (!persistSettingsOrRespond(res, settings)) return;
    return res.json({ success: true });
  });

  app.get('/api/recovery/status', (_req, res) => {
    res.json(getRecoveryStatus());
  });

  app.post('/api/recovery/snapshot', async (_req, res) => {
    try {
      const snapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: getDevFlowDbPath() });
      return res.status(snapshot.usable ? 201 : 500).json({ snapshot, recovery: getRecoveryStatus() });
    } catch (error: any) {
      return res.status(500).json({ error: 'Recovery snapshot failed.', code: 'BACKUP_SNAPSHOT_FAILED', reason: error?.message || String(error) });
    }
  });

  app.post('/api/recovery/restore-drill', async (_req, res) => {
    const drill = await runLatestRestoreDrill({ activeDbPath: getDevFlowDbPath() });
    return res.status(drill.ok ? 200 : 409).json({ drill, recovery: getRecoveryStatus() });
  });

  app.get('/api/export', async (_req, res) => {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const exportFilename = `devflow-backup-${timestamp}.db`;
      const snapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: getDevFlowDbPath() });
      if (!snapshot.usable) {
        return res.status(500).json({ error: 'Backup failed integrity validation.', code: 'BACKUP_VALIDATION_FAILED' });
      }
      return res.download(snapshot.dbPath, exportFilename, (err) => {
        if (err && !res.headersSent) res.status(500).json({ error: 'Failed to send export file' });
      });
    } catch (error: any) {
      console.error('Export failed:', error);
      return res.status(500).json({ error: error.message ?? 'Export failed' });
    }
  });

  app.post('/api/import', express.raw({ type: '*/*', limit: '50mb' }), async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(400).json({ error: 'Invalid file payload' });
      }

      const dataDir = getDevFlowDataDir();
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const tempFile = path.join(dataDir, `devflow-import-temp-${timestamp}.db`);
      const targetDbFile = getDevFlowDbPath();

      // 1. Save uploaded file to temp path
      fs.writeFileSync(tempFile, req.body);

      // 2. Validate integrity and migration compatibility before touching the active DB.
      const verification = verifyBackupFile({ backupPath: tempFile });
      if (!verification.ok) {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
        return res.status(400).json({ error: verification.reason || 'Invalid DevFlow database file.', code: verification.code });
      }
      const counts = verification.counts || {};

      // 3. Create a verified, secret-sanitized safety snapshot of the current DB.
      let safetyBackupPath = '';
      if (fs.existsSync(targetDbFile)) {
        const safetySnapshot = await createVerifiedBackupSnapshot({ sourceDb: db, sourceDbPath: targetDbFile });
        safetyBackupPath = safetySnapshot.dbPath;
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
        safetyBackupPath,
        counts
      });
    } catch (error: any) {
      console.error('Import failed:', error);
      res.status(500).json({ error: error.message ?? 'Import failed' });
    }
  });
}
