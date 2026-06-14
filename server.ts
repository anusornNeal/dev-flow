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

  const activeTransports = new Set<SSEServerTransport>();

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
    console.log('Received SSE connection request');
    const mcpServer = createDevFlowMcpServer(apiBaseUrl);
    const transport = new SSEServerTransport('/sse', res);
    activeTransports.add(transport);

    res.on('close', () => {
      console.log('SSE connection closed, removing transport');
      activeTransports.delete(transport);
    });

    try {
      await mcpServer.connect(transport);
    } catch (err) {
      console.error('MCP Server connect error:', err);
    }
  });

  app.post('/sse', async (req, res, next) => {
    const transportsArray = Array.from(activeTransports);
    const transport = transportsArray[transportsArray.length - 1];

    if (!transport) {
      res.status(400).send('No active SSE connection');
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

  const activeProxyTransports: Record<string, Set<SSEServerTransport>> = {};

  Object.keys(mcpProxyServers).forEach((serverName) => {
    activeProxyTransports[serverName] = new Set<SSEServerTransport>();
    const config = mcpProxyServers[serverName];
    const routes = [`/proxy/${serverName}/sse`];
    if (serverName === 'github') routes.push('/github/sse');

    routes.forEach((route) => {
      app.get(route, async (_req, res) => {
        console.log(`Received ${serverName} SSE connection request on ${route}`);
        const sseTransport = new SSEServerTransport(route, res);
        activeProxyTransports[serverName].add(sseTransport);

        const clientTransport = new StdioClientTransport({
          command: config.command === 'npx' && process.platform === 'win32' ? 'npx.cmd' : config.command,
          args: config.args,
          env: { ...process.env, ...(config.getEnv ? config.getEnv() : {}) },
        });

        sseTransport.onclose = () => {
          console.log(`${serverName} SSE connection closed`);
          activeProxyTransports[serverName].delete(sseTransport);
          clientTransport.close().catch(() => {});
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
          await sseTransport.start();
        } catch (err) {
          console.error(`Error starting ${serverName} Proxy:`, err);
          res.status(500).end();
        }
      });

      app.post(route, async (req, res, next) => {
        const transportsArray = Array.from(activeProxyTransports[serverName]);
        const transport = transportsArray[transportsArray.length - 1];
        if (!transport) {
          res.status(400).send(`No active ${serverName} SSE connection`);
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
