/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFile } from 'child_process';
import db from './src/db/index';
import { migrateJsonToSqlite } from './src/db/migrate';
import { TASK_SCHEMA_DEF, VALID_AGENTS, VALID_EFFORTS, VALID_MODELS } from './src/server/constants';
import { saveProjects as persistProjects, loadProjects as hydrateProjects } from './src/server/repositories/projectRepository';
import { saveSettings as persistSettings, loadSettings as hydrateSettings } from './src/server/repositories/settingsRepository';
import { generateDisplayId as generateTaskDisplayId, loadTasks as hydrateTasks, saveTasks as persistTasks } from './src/server/repositories/taskRepository';
import { loadSkillsRegistry } from './src/server/repositories/skillsRepository';
import { registerApiRoutes } from './src/server/routes/registerApiRoutes';
import { getAgentTaskContext, validateAgentParams } from './src/server/services/taskService';
import type { AppState } from './src/server/types';

migrateJsonToSqlite();

// Hardcoded seed array matching our beautiful mobile tasks
const SEED_TASKS: any[] = [];

const DATA_FILE = path.join(process.cwd(), 'tasks.json');
const PROJECTS_FILE = path.join(process.cwd(), 'projects.json');
const COUNTERS_FILE = path.join(process.cwd(), 'counters.json');
const AGENT_LOG_FILE = path.join(process.cwd(), 'agent-trigger.log');

// Write a timestamped entry to the agent trigger log file
function writeAgentLog(level: 'INFO' | 'ERROR' | 'TRIGGER', message: string) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(AGENT_LOG_FILE, entry, 'utf8');
  } catch (err) {
    console.error('[agent-log] Failed to write log:', err);
  }
  console.log(entry.trim());
}

// Memory cache helpers
let tasksCache: any[] = [];
let projectsCache: any[] = [];
let countersCache: Record<string, number> = {};
let skillsRegistry: any[] = [];
function broadcast(_message: unknown) {}

let settingsCache: { ngrokUrl: string; githubToken: string; jiraToken: string } = { ngrokUrl: '', githubToken: '', jiraToken: '' };

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

  const app = express();
  const PORT = 3000;

  registerApiRoutes(app, {
    state,
    seedTasks: SEED_TASKS,
    writeAgentLog,
  });

  const getAgentTaskContextLogic = (targetId: string, includeLogs = false) => {
    loadTasks();
    return getAgentTaskContext(state, targetId, includeLogs);
  };

  // ================= MCP SSE ENDPOINTS =================
  const activeTransports = new Set<SSEServerTransport>();

  // เพิ่ม Header ป้องกัน ngrok block (ถ้ามี) และ CORS
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, ngrok-skip-browser-warning');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  app.get('/sse', async (req, res) => {
    console.log('Received SSE connection request');
    
    // สร้าง MCP Server ตัวใหม่ทุกครั้งที่มีการเชื่อมต่อ
    const mcpServer = new Server(
      { name: "dev-flow-mcp", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
      return {
        tools: [
          { 
            name: "get_schema", 
            description: "Get the full JSON Schema for tasks in Dev Flow", 
            inputSchema: { type: "object", properties: {} },
            outputSchema: { type: "object" }
          },
          { 
            name: "list_projects", 
            description: "Get a list of all projects", 
            inputSchema: { type: "object", properties: {} },
            outputSchema: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, repoUrl: { type: "string" } } }
            }
          },
          { 
            name: "create_project", 
            description: "Create a new project", 
            inputSchema: { type: "object", properties: { name: { type: "string", description: "Project name" }, repoUrl: { type: "string", description: "Repository URL" }, description: { type: "string", description: "Project description" } }, required: ["name", "repoUrl"] },
            outputSchema: { type: "object", properties: { id: { type: "string" }, name: { type: "string" }, repoUrl: { type: "string" } } }
          },
          { 
            name: "delete_project", 
            description: "Delete a project and all its tasks", 
            inputSchema: { type: "object", properties: { id: { type: "string", description: "Project ID" } }, required: ["id"] },
            outputSchema: { type: "object", properties: { success: { type: "boolean" } } }
          },
          { 
            name: "list_tasks", 
            description: "Get a list of all tasks", 
            inputSchema: { type: "object", properties: { projectId: { type: "string", description: "Optional project ID to filter tasks" }, parentId: { type: "string", description: "Optional parent ID to get subtasks of a specific task" } } },
            outputSchema: {
              type: "array",
              items: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" } } }
            }
          },
          { 
            name: "get_agent_task_context", 
            description: "Get a clean, token-efficient agent-ready task context package. Excludes logs and noisy fields by default. Extracts subtask orchestration if task is a parent.", 
            inputSchema: { type: "object", properties: { taskId: { type: "string", description: "The task id or displayId to fetch." }, includeLogs: { type: "boolean", description: "Set true to include the raw logs array." } }, required: ["taskId"] },
            outputSchema: { type: "object" }
          },
          { 
            name: "create_task", 
            description: "Create a new task", 
            inputSchema: { 
              type: "object", 
              properties: { 
                title: { type: "string", description: "Task title" }, 
                description: { type: "string", description: "Task description" }, 
                projectId: { type: "string", description: "Project ID" }, 
                status: { type: "string", description: "e.g. backlog, todo, in-progress" },
                priority: { type: "string", description: "low, medium, high" },
                branch: { type: "string", description: "Git branch name" },
                tags: { type: "array", items: { type: "string" }, description: "Array of tags" },
                targetFiles: { type: "array", items: { type: "string" }, description: "Array of target files" },
                checklist: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, completed: { type: "boolean" } } }, description: "List of checklist items" },
                effort: { type: "string", enum: VALID_EFFORTS, description: "Estimated effort: low, medium, high, xhigh" },
                model: { type: "string", enum: VALID_MODELS, description: "AI Model Spec" },
                agent: { type: "string", enum: VALID_AGENTS, description: "AI Agent assigned (Codex, Antigravity, Claude). If parentId is set, must match parent's agent." },
                parentId: { type: "string", description: "Parent task ID if this is a subtask. If set, agent must match parent." },
                reasoning: { type: "string", description: "Reasoning or context" },
                acceptanceCriteria: { type: "string", description: "Acceptance criteria" },
                verification: { type: "string", description: "Verification steps" },
                repoContext: { type: "string", description: "Repository context" },
                jiraKey: { type: "string", description: "Jira Issue Key" },
                repo: { type: "string", description: "Repository URL" },
                sourceUrl: { type: "string", description: "Source URL" }
              }, 
              required: ["title"] 
            },
            outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" } } }
          },
          { 
            name: "update_task", 
            description: "Update an existing task", 
            inputSchema: { 
              type: "object", 
              properties: { 
                taskId: { type: "string", description: "Task ID to update" },
                title: { type: "string", description: "Task title" }, 
                description: { type: "string", description: "Task description" }, 
                projectId: { type: "string", description: "Project ID" }, 
                status: { type: "string", description: "e.g. backlog, todo, in-progress" },
                priority: { type: "string", description: "low, medium, high" },
                branch: { type: "string", description: "Git branch name" },
                tags: { type: "array", items: { type: "string" }, description: "Array of tags" },
                targetFiles: { type: "array", items: { type: "string" }, description: "Array of target files" },
                checklist: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, completed: { type: "boolean" } } }, description: "List of checklist items" },
                effort: { type: "string", enum: VALID_EFFORTS, description: "Estimated effort: low, medium, high, xhigh" },
                model: { type: "string", enum: VALID_MODELS, description: "AI Model Spec" },
                agent: { type: "string", enum: VALID_AGENTS, description: "AI Agent assigned (Codex, Antigravity, Claude). If parentId is set, must match parent's agent." },
                parentId: { type: "string", description: "Parent task ID if this is a subtask. If set, agent must match parent." },
                reasoning: { type: "string", description: "Reasoning or context" },
                acceptanceCriteria: { type: "string", description: "Acceptance criteria" },
                verification: { type: "string", description: "Verification steps" },
                repoContext: { type: "string", description: "Repository context" },
                jiraKey: { type: "string", description: "Jira Issue Key" },
                repo: { type: "string", description: "Repository URL" },
                sourceUrl: { type: "string", description: "Source URL" }
              }, 
              required: ["taskId"] 
            },
            outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" } } }
          },
          { 
            name: "move_task_status", 
            description: "Move a task to a different status", 
            inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Task ID to move" }, status: { type: "string", description: "backlog, todo, in-progress, ready-for-review, or done" } }, required: ["taskId", "status"] },
            outputSchema: { type: "object", properties: { id: { type: "string" }, title: { type: "string" }, status: { type: "string" } } }
          },
          { 
            name: "delete_task", 
            description: "Delete a task by ID", 
            inputSchema: { type: "object", properties: { taskId: { type: "string", description: "Task ID" } }, required: ["taskId"] },
            outputSchema: { type: "object", properties: { success: { type: "boolean" } } }
          },
          { 
            name: "read_local_file", 
            description: "Read a local file or documentation from the project directory", 
            inputSchema: { type: "object", properties: { filePath: { type: "string", description: "Relative path to the file (e.g. 'README.md', 'src/App.tsx')" } }, required: ["filePath"] },
            outputSchema: { type: "object", properties: { content: { type: "string" } } }
          },
          { 
            name: "list_local_files", 
            description: "List files and directories in the project directory", 
            inputSchema: { type: "object", properties: { directoryPath: { type: "string", description: "Relative directory path (e.g. '.', 'src')" } } },
            outputSchema: { type: "object", properties: { files: { type: "array", items: { type: "string" } } } }
          },
          {
            name: "list_skills",
            description: "Get a list of all available DevFlow skills",
            inputSchema: { type: "object", properties: {} },
            outputSchema: { type: "array", items: { type: "object" } }
          },
          {
            name: "get_skill",
            description: "Get the content of a specific skill by ID",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "Skill ID (e.g. 'schema', 'playbook')" } }, required: ["id"] },
            outputSchema: { type: "object" }
          },
          {
            name: "update_skill",
            description: "Update the content of a specific skill",
            inputSchema: { type: "object", properties: { id: { type: "string", description: "Skill ID" }, content: { type: "string", description: "New skill content" } }, required: ["id", "content"] },
            outputSchema: { type: "object", properties: { success: { type: "boolean" } } }
          }
        ] as any
      };
    });

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      if (name === "get_schema") {
        return { content: [{ type: "text", text: JSON.stringify(TASK_SCHEMA_DEF, null, 2) }] };
      }
      if (name === "list_projects") {
        return { content: [{ type: "text", text: JSON.stringify(projectsCache, null, 2) }] };
      }
      if (name === "create_project") {
        const { name: pName, repoUrl, description } = args as any;
        const newProject = {
          id: `project-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          name: pName,
          repoUrl,
          description: description || "",
          createdAt: new Date().toISOString()
        };
        projectsCache.push(newProject);
        saveProjects();
        return { content: [{ type: "text", text: JSON.stringify(newProject, null, 2) }] };
      }
      if (name === "delete_project") {
        const { id } = args as any;
        if (id === 'project-default') {
          return { isError: true, content: [{ type: "text", text: 'Cannot delete default project' }] };
        }
        const index = projectsCache.findIndex((p: any) => p.id === id);
        if (index === -1) {
          return { isError: true, content: [{ type: "text", text: 'Project not found' }] };
        }
        projectsCache.splice(index, 1);
        saveProjects();
        const initialLen = tasksCache.length;
        tasksCache = tasksCache.filter((t: any) => t.projectId !== id);
        if (tasksCache.length !== initialLen) saveTasks();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, removedId: id }, null, 2) }] };
      }
      if (name === "list_tasks") {
        const { projectId, parentId } = args as any;
        let filtered = tasksCache;
        if (projectId) filtered = filtered.filter((t: any) => t.projectId === projectId);
        if (parentId) filtered = filtered.filter((t: any) => t.parentId === parentId);
        return { content: [{ type: "text", text: JSON.stringify(filtered, null, 2) }] };
      }
      if (name === "get_agent_task_context") {
        const { taskId, includeLogs } = args as any;
        const context = getAgentTaskContextLogic(taskId, !!includeLogs);
        if (!context) {
           return { isError: true, content: [{ type: "text", text: `Task ${taskId} not found.` }] };
        }
        return { content: [{ type: "text", text: JSON.stringify(context, null, 2) }] };
      }
      if (name === "create_task") {
        loadTasks();
        const agentValidationError = validateAgentParams(args, tasksCache);
        if (agentValidationError) {
          return { content: [{ type: "text", text: `Error: ${agentValidationError}` }] };
        }

        if (!args?.projectId) {
          return { isError: true, content: [{ type: "text", text: "Task creation requires a valid explicit projectId" }] };
        }
        const pId = String(args.projectId);
        if (pId === 'project-default') {
          return { isError: true, content: [{ type: "text", text: "Target project 'project-default' is no longer supported." }] };
        }
        const newTask = {
          id: `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          displayId: generateDisplayId(pId),
          title: args?.title,
          description: args?.description || "",
          projectId: pId,
          status: args?.status || "backlog",
          priority: args?.priority || "medium",
          branch: args?.branch || undefined,
          tags: Array.isArray(args?.tags) ? args?.tags : [],
          targetFiles: Array.isArray(args?.targetFiles) ? args?.targetFiles : [],
          checklist: Array.isArray(args?.checklist) ? args?.checklist : [],
          effort: args?.effort || undefined,
          model: args?.model || undefined,
          agent: args?.agent || undefined,
          parentId: args?.parentId || undefined,
          reasoning: args?.reasoning || undefined,
          acceptanceCriteria: args?.acceptanceCriteria || undefined,
          verification: args?.verification || undefined,
          repoContext: args?.repoContext || undefined,
          jiraKey: args?.jiraKey || undefined,
          repo: args?.repo || undefined,
          sourceUrl: args?.sourceUrl || undefined,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          logs: [{ id: `log-${Date.now()}-mcp`, timestamp: new Date().toISOString(), message: 'Task created via MCP Server.', type: 'create' }]
        };
        tasksCache.push(newTask);
        saveTasks();
        return { content: [{ type: "text", text: JSON.stringify(newTask, null, 2) }] };
      }
      if (name === "update_task") {
        loadTasks();
        const { taskId, ...updateFields } = args as any;
        const index = tasksCache.findIndex((t: any) => t.id === taskId);
        if (index === -1) {
          return { isError: true, content: [{ type: "text", text: `Task ${taskId} not found.` }] };
        }
        
        const agentValidationError = validateAgentParams(updateFields, tasksCache);
        if (agentValidationError) {
          return { isError: true, content: [{ type: "text", text: `Error: ${agentValidationError}` }] };
        }

        const currentTask = tasksCache[index];

        // Enforce lock
        if (currentTask.status === 'in-progress') {
          const isAgentRequest = args?.isAgentRequest === true || String(args?.isAgentRequest).toLowerCase() === 'true';
          const isEmergency = args?.emergency === true || String(args?.emergency).toLowerCase() === 'true';
          if (!isAgentRequest && !isEmergency) {
            return { isError: true, content: [{ type: "text", text: "Task is locked by an agent. Use emergency flag to override." }] };
          }
        }

        const updatedTask = { ...currentTask, ...updateFields, updatedAt: new Date().toISOString() };

        if (['backlog', 'done', 'ready-for-review'].includes(updatedTask.status)) {
          updatedTask.activeAgent = undefined;
        }
        updatedTask.logs = [...currentTask.logs, { id: `log-${Date.now()}-mcp-upd`, timestamp: new Date().toISOString(), message: 'Task updated via MCP Server.', type: 'update' }];
        tasksCache[index] = updatedTask;
        saveTasks();
        return { content: [{ type: "text", text: JSON.stringify(updatedTask, null, 2) }] };
      }
      if (name === "move_task_status") {
        loadTasks();
        const { taskId, status } = args as any;
        const index = tasksCache.findIndex((t: any) => t.id === taskId);
        if (index === -1) {
          return { isError: true, content: [{ type: "text", text: `Task ${taskId} not found.` }] };
        }
        
        const currentTask = tasksCache[index];
        // Enforce lock
        if (currentTask.status === 'in-progress') {
          const isAgentRequest = args?.isAgentRequest === true || String(args?.isAgentRequest).toLowerCase() === 'true';
          const isEmergency = args?.emergency === true || String(args?.emergency).toLowerCase() === 'true';
          if (!isAgentRequest && !isEmergency) {
            return { isError: true, content: [{ type: "text", text: "Task is locked by an agent. Use emergency flag to override." }] };
          }
        }
        
        tasksCache[index].status = status;
        tasksCache[index].updatedAt = new Date().toISOString();
        if (['backlog', 'done', 'ready-for-review'].includes(status)) {
          tasksCache[index].activeAgent = undefined;
        }
        tasksCache[index].logs.push({ id: `log-${Date.now()}-mcp-move`, timestamp: new Date().toISOString(), message: `Status moved to ${status} via MCP Server.`, type: 'move' });
        saveTasks();
        return { content: [{ type: "text", text: JSON.stringify(tasksCache[index], null, 2) }] };
      }
      if (name === "delete_task") {
        loadTasks();
        const { taskId } = args as any;
        const index = tasksCache.findIndex((t: any) => t.id === taskId);
        if (index === -1) {
          return { isError: true, content: [{ type: "text", text: `Task ${taskId} not found.` }] };
        }
        
        const currentTask = tasksCache[index];
        // Enforce lock
        if (currentTask.status === 'in-progress') {
          const isAgentRequest = args?.isAgentRequest === true || String(args?.isAgentRequest).toLowerCase() === 'true';
          const isEmergency = args?.emergency === true || String(args?.emergency).toLowerCase() === 'true';
          if (!isAgentRequest && !isEmergency) {
            return { isError: true, content: [{ type: "text", text: "Task is locked by an agent. Use emergency flag to override." }] };
          }
        }
        
        const removed = tasksCache.splice(index, 1);
        saveTasks();
        return { content: [{ type: "text", text: JSON.stringify({ success: true, removed: removed[0] }, null, 2) }] };
      }
      if (name === "read_local_file") {
        const { filePath } = args as any;
        const fullPath = path.resolve(process.cwd(), filePath);
        if (!fullPath.startsWith(process.cwd())) {
           return { isError: true, content: [{ type: "text", text: "Access denied. Cannot read outside project directory." }] };
        }
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          return { content: [{ type: "text", text: JSON.stringify({ content }, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
      }
      if (name === "list_local_files") {
        const { directoryPath } = args as any;
        const fullPath = path.resolve(process.cwd(), directoryPath || ".");
        if (!fullPath.startsWith(process.cwd())) {
           return { isError: true, content: [{ type: "text", text: "Access denied. Cannot list outside project directory." }] };
        }
        try {
          const files = fs.readdirSync(fullPath);
          return { content: [{ type: "text", text: JSON.stringify({ files }, null, 2) }] };
        } catch (err: any) {
          return { isError: true, content: [{ type: "text", text: err.message }] };
        }
      }
      throw new Error(`Unknown tool: ${name}`);
    });

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
    // เลือก Transport ตัวล่าสุดที่ยังมีชีวิตอยู่
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

  // ================= DYNAMIC MCP PROXY ENDPOINTS =================
  const mcpServersConfigPath = path.resolve(process.cwd(), 'mcp-servers.json');
  let mcpProxyServers: Record<string, any> = {};
  if (fs.existsSync(mcpServersConfigPath)) {
    try {
      mcpProxyServers = JSON.parse(fs.readFileSync(mcpServersConfigPath, 'utf8')).mcpServers || {};
    } catch (err) {
      console.error('Error reading mcp-servers.json:', err);
    }
  }

  // Fallback default github proxy for convenience
  if (!mcpProxyServers['github']) {
    mcpProxyServers['github'] = {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || '' }
    };
  }

  const activeProxyTransports: Record<string, Set<SSEServerTransport>> = {};

  Object.keys(mcpProxyServers).forEach(serverName => {
    activeProxyTransports[serverName] = new Set<SSEServerTransport>();
    const config = mcpProxyServers[serverName];

    // Expose both /github/sse (legacy) and /proxy/github/sse
    const routes = [`/proxy/${serverName}/sse`];
    if (serverName === 'github') routes.push('/github/sse');

    routes.forEach(route => {
      app.get(route, async (req, res) => {
        console.log(`Received ${serverName} SSE connection request on ${route}`);
        const sseTransport = new SSEServerTransport(route, res);
        activeProxyTransports[serverName].add(sseTransport);

        const clientTransport = new StdioClientTransport({
          command: config.command === 'npx' && process.platform === 'win32' ? 'npx.cmd' : config.command,
          args: config.args,
          env: { ...process.env, ...(config.env || {}) }
        });

        sseTransport.onclose = () => {
          console.log(`${serverName} SSE connection closed`);
          activeProxyTransports[serverName].delete(sseTransport);
          clientTransport.close().catch(() => {});
        };

        clientTransport.onclose = () => {
          sseTransport.close().catch(() => {});
        };

        sseTransport.onmessage = (msg) => {
          clientTransport.send(msg).catch(err => console.error(`Error sending to ${serverName} MCP:`, err));
        };

        clientTransport.onmessage = (msg) => {
          sseTransport.send(msg).catch(err => console.error(`Error sending to ${serverName} SSE:`, err));
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

  // ================= VITE ASSET MIDDLEWARES =================

  if (process.env.NODE_ENV !== 'production') {
    // Avoid dynamic config loading on Windows due to TSX absolute path URL scheme bugs
    const isWindows = process.platform === 'win32';
    const viteConfig: any = {
      server: { 
        middlewareMode: true,
        allowedHosts: true,
        watch: {
          ignored: ['**/tasks.json']
        }
      },
      appType: 'spa',
    };

    if (isWindows) {
      // Import plugins dynamically here to avoid Vite loading vite.config.ts itself
      const tailwindcssPlugin = (await import('@tailwindcss/vite')).default;
      const reactPlugin = (await import('@vitejs/plugin-react')).default;
      
      viteConfig.configFile = false;
      viteConfig.plugins = [reactPlugin(), tailwindcssPlugin()];
      viteConfig.resolve = {
        alias: {
          '@': path.resolve(process.cwd(), '.'),
        }
      };
    }

    const vite = await createViteServer(viteConfig);
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Express developer server active on http://0.0.0.0:${PORT}`);
  });
}

startServer();
