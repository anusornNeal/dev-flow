/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { saveProjects as persistProjects, loadProjects as hydrateProjects } from './src/server/repositories/projectRepository';
import { saveSettings as persistSettings, loadSettings as hydrateSettings } from './src/server/repositories/settingsRepository';
import { generateDisplayId as generateTaskDisplayId, loadTasks as hydrateTasks, saveTasks as persistTasks } from './src/server/repositories/taskRepository';
import { loadSkillsRegistry } from './src/server/repositories/skillsRepository';
import { registerApiRoutes } from './src/server/routes/registerApiRoutes';
import { createDevFlowMcpServer } from './src/server/mcp';
import type { AppState } from './src/server/types';
import { getDevFlowAppRoot, resolveFromDevFlowAppRoot } from './src/lib/devFlowPaths';

const AGENT_LOG_FILE = resolveFromDevFlowAppRoot('logs', 'agent-trigger.log');

function writeAgentLog(level: 'INFO' | 'ERROR' | 'TRIGGER', message: string) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(AGENT_LOG_FILE, entry, 'utf8');
  } catch (err) {
    console.error('[agent-log] Failed to write log:', err);
  }
  console.log(entry.trim());
}

let tasksCache: any[] = [];
let projectsCache: any[] = [];
let countersCache: Record<string, number> = {};
let skillsRegistry: any[] = [];
let settingsCache: {
  ngrokUrl: string;
  githubToken: string;
  jiraToken: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  autoWork: boolean;
  agentExecutionMode?: string;
} = {
  ngrokUrl: '',
  githubToken: '',
  jiraToken: '',
  jiraBaseUrl: '',
  jiraEmail: '',
  autoWork: false,
  agentExecutionMode: '',
};

const state: AppState = {
  get tasksCache() {
    return tasksCache;
  },
  set tasksCache(value) {
    tasksCache = value;
  },
  get projectsCache() {
    return projectsCache;
  },
  set projectsCache(value) {
    projectsCache = value;
  },
  get countersCache() {
    return countersCache;
  },
  set countersCache(value) {
    countersCache = value;
  },
  get settingsCache() {
    return settingsCache;
  },
  set settingsCache(value) {
    settingsCache = value;
  },
  get skillsRegistry() {
    return skillsRegistry;
  },
  set skillsRegistry(value) {
    skillsRegistry = value;
  },
};

function loadSettings() {
  hydrateSettings(state);
}

function saveSettings() {
  persistSettings(state);
}

function loadProjects() {
  hydrateProjects(state);
}

function saveProjects() {
  persistProjects(state);
}

function loadTasks() {
  hydrateTasks(state);
}

function saveTasks() {
  persistTasks(state);
}

function sanitizeStartupTasks() {
  let changed = false;
  for (const task of state.tasksCache) {
    if (task.status === 'in-progress' && !task.activeAgent) {
      task.status = 'todo';
      changed = true;
    }
  }
  if (changed) saveTasks();
}

function loadSkills() {
  loadSkillsRegistry(state);
}

function generateDisplayId(projectId: string) {
  return generateTaskDisplayId(state, projectId);
}

loadSettings();

async function startServer() {
  loadProjects();
  loadTasks();
  loadSkills();
  sanitizeStartupTasks();

  const app = express();
  const port = 3000;
  const apiBaseUrl = `http://127.0.0.1:${port}`;

  registerApiRoutes(app, {
    state,
    writeAgentLog,
  });

  const activeTransports = new Map<string, SSEServerTransport>();
  const debugSse = process.env.DEBUG_SSE === '1';
  const shortId = (id: string) => id.slice(0, 8);

  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning, x-correlation-id');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  app.get('/sse', async (_req, res) => {
    const mcpServer = createDevFlowMcpServer(apiBaseUrl);
    const transport = new SSEServerTransport('/sse', res);
    activeTransports.set(transport.sessionId, transport);
    if (debugSse) console.log(`[sse route=/sse] open sid=${shortId(transport.sessionId)} active=${activeTransports.size}`);

    res.on('close', () => {
      activeTransports.delete(transport.sessionId);
      if (debugSse) console.log(`[sse route=/sse] close sid=${shortId(transport.sessionId)} active=${activeTransports.size}`);
    });

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      activeTransports.delete(transport.sessionId);
      console.error('MCP Server connect error:', err);
    }
  });

  // POST /sse must route to the session-specific transport, NOT the latest.
  // MCP clients identify themselves via ?sessionId= query parameter.
  // Using a Set and picking the last element breaks under multiple concurrent
  // clients (e.g., Tool A's message routes to Tool B's transport).
  app.post('/sse', async (req, res, next) => {
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
    const transport = sessionId ? activeTransports.get(sessionId) : undefined;

    if (debugSse) {
      if (transport) {
        console.log(`[sse route=/sse] POST hit sid=${shortId(sessionId)}`);
      } else {
        console.log(`[sse route=/sse] POST miss sid=${shortId(sessionId) || 'none'} active=${activeTransports.size}`);
      }
    }

    if (!transport) {
      res.status(400).json({ error: 'No active SSE connection for session' });
      return;
    }

    try {
      await transport.handlePostMessage(req, res);
    } catch (err) {
      console.error('Error handling POST message:', err);
      next(err);
    }
  });

  const mcpProxyServers: Record<string, { command: string; args: string[]; getEnv: () => Record<string, string> }> = {
    github: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      getEnv: () => ({
        GITHUB_PERSONAL_ACCESS_TOKEN: state.settingsCache.githubToken || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '',
      }),
    },
    jira: {
      command: 'npx',
      args: ['-y', 'mcp-jira-stdio'],
      getEnv: () => ({
        JIRA_BASE_URL: state.settingsCache.jiraBaseUrl || process.env.JIRA_BASE_URL || '',
        JIRA_EMAIL: state.settingsCache.jiraEmail || process.env.JIRA_EMAIL || '',
        JIRA_API_TOKEN: state.settingsCache.jiraToken || process.env.JIRA_API_TOKEN || process.env.JIRA_PERSONAL_ACCESS_TOKEN || '',
      }),
    },
  };

  const activeProxyTransports: Record<string, Map<string, SSEServerTransport>> = {};

  Object.keys(mcpProxyServers).forEach((serverName) => {
    activeProxyTransports[serverName] = new Map<string, SSEServerTransport>();
    const config = mcpProxyServers[serverName];
    const routes = [`/proxy/${serverName}/sse`];
    if (serverName === 'github') routes.push('/github/sse');

    routes.forEach((route) => {
      app.get(route, async (_req, res) => {
        const sseTransport = new SSEServerTransport(route, res);
        activeProxyTransports[serverName].set(sseTransport.sessionId, sseTransport);
        if (debugSse) console.log(`[proxy:${serverName} route=${route}] open sid=${shortId(sseTransport.sessionId)} active=${activeProxyTransports[serverName].size}`);

        const clientTransport = new StdioClientTransport({
          command: config.command === 'npx' && process.platform === 'win32' ? 'npx.cmd' : config.command,
          args: config.args,
          env: { ...process.env, ...(config.getEnv ? config.getEnv() : {}) },
        });

        sseTransport.onclose = () => {
          activeProxyTransports[serverName].delete(sseTransport.sessionId);
          clientTransport.close().catch(() => {});
          if (debugSse) console.log(`[proxy:${serverName} route=${route}] close sid=${shortId(sseTransport.sessionId)} active=${activeProxyTransports[serverName].size}`);
        };

        clientTransport.onclose = () => {
          sseTransport.close().catch(() => {});
        };

        sseTransport.onmessage = (message) => {
          clientTransport.send(message).catch((err) => console.error(`Error sending to ${serverName} MCP:`, err));
        };

        clientTransport.onmessage = (message) => {
          sseTransport.send(message).catch((err) => console.error(`Error sending to ${serverName} SSE:`, err));
        };

        try {
          await clientTransport.start();
          try {
            await sseTransport.start();
          } catch (err) {
            clientTransport.close().catch(() => {});
            throw err;
          }
        } catch (err) {
          activeProxyTransports[serverName].delete(sseTransport.sessionId);
          if (!res.headersSent && !res.writableEnded) {
            res.status(500).end();
          }
          console.error(`Error starting ${serverName} Proxy:`, err);
        }
      });

      app.post(route, async (req, res, next) => {
        const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : '';
        const transport = sessionId ? activeProxyTransports[serverName].get(sessionId) : undefined;
        if (debugSse) {
          if (transport) {
            console.log(`[proxy:${serverName} route=${route}] POST hit sid=${shortId(sessionId)}`);
          } else {
            console.log(`[proxy:${serverName} route=${route}] POST miss sid=${shortId(sessionId) || 'none'} active=${activeProxyTransports[serverName].size}`);
          }
        }
        if (!transport) {
          res.status(400).json({ error: `No active ${serverName} SSE connection for session` });
          return;
        }
        try {
          await transport.handlePostMessage(req, res);
        } catch (err) {
          console.error(`Error handling ${serverName} POST message:`, err);
          next(err);
        }
      });
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const isWindows = process.platform === 'win32';
    const viteConfig: any = {
      root: getDevFlowAppRoot(),
      server: {
        middlewareMode: true,
        allowedHosts: true,
        watch: {
          ignored: ['**/tasks.json'],
        },
      },
      appType: 'spa',
    };

    if (isWindows) {
      const tailwindcssPlugin = (await import('@tailwindcss/vite')).default;
      const reactPlugin = (await import('@vitejs/plugin-react')).default;

      viteConfig.configFile = false;
      viteConfig.plugins = [reactPlugin(), tailwindcssPlugin()];
      viteConfig.resolve = {
        alias: {
          '@': getDevFlowAppRoot(),
        },
      };
    }

    const vite = await createViteServer(viteConfig);
    app.use(vite.middlewares);
  } else {
    const distPath = resolveFromDevFlowAppRoot('dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Express developer server active on http://0.0.0.0:${port}`);
  });
}

startServer();
