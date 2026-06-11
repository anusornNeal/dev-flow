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

function loadCounters() {
  if (fs.existsSync(COUNTERS_FILE)) {
    try {
      countersCache = JSON.parse(fs.readFileSync(COUNTERS_FILE, 'utf8'));
    } catch (e) {
      countersCache = {};
    }
  }
}

function saveCounters() {
  try {
    fs.writeFileSync(COUNTERS_FILE, JSON.stringify(countersCache, null, 2), 'utf8');
  } catch (err) {}
}

const SETTINGS_FILE = path.join(process.cwd(), 'settings.json');
let settingsCache: { autoWorking: boolean } = { autoWorking: false };

function loadSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      settingsCache = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
      settingsCache = { autoWorking: false };
    }
  } else {
    saveSettings();
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settingsCache, null, 2), 'utf8');
  } catch (err) {}
}

loadSettings();

/// Auto-Dispatch Logic
function drainReadyToDoQueue() {
  if (!settingsCache.autoWorking) return;
  loadTasks();
  
  // Group tasks by project
  const projectTasks = new Map<string, any[]>();
  for (const t of tasksCache) {
    if (!projectTasks.has(t.projectId)) {
      projectTasks.set(t.projectId, []);
    }
    projectTasks.get(t.projectId)!.push(t);
  }

  let changed = false;

  for (const [projectId, tasks] of projectTasks.entries()) {
    // Check if an agent is busy for this project
    const isAgentBusy = tasks.some(t => 
      (t.status === 'in-progress' || t.status === 'todo') && t.activeAgent
    );
    if (isAgentBusy) continue;

    // Find first valid ready-to-do task
    const readyTask = tasks.find(t => 
      t.status === 'todo' && t.agent && t.model && t.effort && !t.activeAgent
    );

    if (readyTask) {
      const proj = projectsCache.find(p => p.id === projectId);
      if (!proj || !proj.localPath) {
        continue;
      }

      // Claim it
      readyTask.status = 'in-progress';
      readyTask.activeAgent = readyTask.agent;
      readyTask.updatedAt = new Date().toISOString();
      readyTask.logs = [
        ...(readyTask.logs || []),
        {
          id: `log-auto-${Date.now()}`,
          timestamp: new Date().toISOString(),
          message: 'Task auto-dispatched to IN-PROGRESS via Auto-Working loop.',
          type: 'move'
        }
      ];
      changed = true;

      // Trigger it
      const triggerBat = path.join(process.cwd(), 'trigger-agent.bat');
      const execOpts = proj.localPath ? { cwd: proj.localPath } : undefined;
      const safeLocalPath = `"${proj.localPath}"`;
      const safeModel = `"${readyTask.model}"`;
      const safeEffort = `"${readyTask.effort}"`;

      writeAgentLog('TRIGGER', `Auto-dispatch spawning agent=${readyTask.agent} for task=${readyTask.id} ("${readyTask.title}") at ${proj.localPath}`);
      execFile('cmd.exe', ['/c', triggerBat, readyTask.agent, readyTask.id, safeLocalPath, safeModel, safeEffort], execOpts, (err) => {
        if (err) writeAgentLog('ERROR', `trigger-agent.bat failed for task=${readyTask.id}: ${err.message}`);
        else writeAgentLog('INFO', `trigger-agent.bat exited OK for task=${readyTask.id}`);
      });
    }
  }

  if (changed) {
    saveTasks();
    broadcast({ type: 'tasks', data: tasksCache });
  }
}

// Auto-Dispatch Loop
setInterval(drainReadyToDoQueue, 5000);

const VALID_AGENTS = ['Codex', 'Antigravity', 'Claude'];
const VALID_EFFORTS = ['low', 'medium', 'high', 'xhigh'];
const VALID_MODELS = [
  'GPT-5.5', 'GPT-5.4', 'GPT-5.4 Mini', 
  'Gemini 3.5 Flash', 'Gemini 3.1 Pro', 
  'Claude 4.8 Opus', 'Claude 4.7 Opus', 'Claude 4.6 Opus', 'Claude 4.6 Sonnet'
];

const VALID_STATUSES = ['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'];
const VALID_PRIORITIES = ['low', 'medium', 'high'];

// --- Manual Validation Utilities ---
function validateString(value: any, fieldName: string, required = false): string | null {
  if (value === undefined || value === null) {
    return required ? `Field '${fieldName}' is required.` : null;
  }
  if (typeof value !== 'string') return `Field '${fieldName}' must be a string.`;
  if (required && value.trim() === '') return `Field '${fieldName}' cannot be empty.`;
  return null;
}

function validateEnum(value: any, fieldName: string, validValues: string[], required = false): string | null {
  if (value === undefined || value === null || value === '') {
    return required ? `Field '${fieldName}' is required.` : null;
  }
  if (!validValues.includes(value)) {
    return `Field '${fieldName}' must be one of: ${validValues.join(', ')}. Received: ${value}`;
  }
  return null;
}

function validateTaskPayload(item: any, isUpdate = false): string | null {
  if (!item || typeof item !== 'object') return 'Task payload must be an object.';
  
  const titleErr = validateString(item.title, 'title', !isUpdate);
  if (titleErr) return titleErr;
  
  const statusErr = validateEnum(item.status, 'status', VALID_STATUSES, false);
  if (statusErr) return statusErr;

  const priorityErr = validateEnum(item.priority, 'priority', VALID_PRIORITIES, false);
  if (priorityErr) return priorityErr;

  const effortErr = validateEnum(item.effort, 'effort', VALID_EFFORTS, false);
  if (effortErr) return effortErr;

  const modelErr = validateEnum(item.model, 'model', VALID_MODELS, false);
  if (modelErr) return modelErr;

  const agentErr = validateEnum(item.agent, 'agent', VALID_AGENTS, false);
  if (agentErr) return agentErr;

  if (item.tags !== undefined && !Array.isArray(item.tags)) return `Field 'tags' must be an array.`;
  if (item.targetFiles !== undefined && !Array.isArray(item.targetFiles)) return `Field 'targetFiles' must be an array.`;
  if (item.checklist !== undefined && !Array.isArray(item.checklist)) return `Field 'checklist' must be an array.`;
  if (item.designImages !== undefined) {
    if (!Array.isArray(item.designImages)) return `Field 'designImages' must be an array.`;
    if (item.designImages.length > 5) return `Field 'designImages' can contain at most 5 images.`;
  }
  
  return null;
}

function extractDesignImages(item: any, currentTask?: any): string[] | undefined {
  if (item.designImages !== undefined) return item.designImages;
  if (item.designImage !== undefined) return item.designImage ? [item.designImage] : [];
  if (currentTask) return currentTask.designImages || (currentTask.designImage ? [currentTask.designImage] : undefined);
  return undefined;
}

const TASK_SCHEMA_DEF = {
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "Task or Batch Task Payload",
  "type": "object",
  "description": "When creating tasks via API, DO NOT send 'id' or 'displayId'. The backend will generate them automatically. You can send a single Task object, an array of Tasks, or a nested structure { parent: Task, children: Task[] }.",
  "properties": {
    "id": { "type": "string", "description": "READ-ONLY. Generated by backend. Do NOT send during creation." },
    "displayId": { "type": "string", "description": "READ-ONLY. Generated by backend. Do NOT send during creation." },
    "projectId": { "type": "string", "description": "Project ID this task belongs to" },
    "title": { "type": "string", "description": "Title of the task" },
    "description": { "type": "string", "description": "Detailed description of the task (Markdown)" },
    "status": { 
      "type": "string", 
      "enum": ["backlog", "todo", "in-progress", "ready-for-review", "done"],
      "description": "Current status of the task"
    },
    "branch": { "type": "string", "description": "Git branch name associated with this task" },
    "priority": { 
      "type": "string", 
      "enum": ["low", "medium", "high"],
      "description": "Priority level"
    },
    "tags": { 
      "type": "array", 
      "items": { "type": "string" },
      "description": "List of tags/labels"
    },
    "targetFiles": { 
      "type": "array", 
      "items": { "type": "string" },
      "description": "Files relevant to the task"
    },
    "checklist": { 
      "type": "array", 
      "items": { 
        "type": "object", 
        "properties": {
          "id": { "type": "string" },
          "text": { "type": "string" },
          "completed": { "type": "boolean" }
        },
        "required": ["id", "text", "completed"]
      },
      "description": "Sub-tasks or checklist items"
    },
    "designImages": { "type": "array", "items": { "type": "string" }, "maxItems": 5, "description": "Array of up to 5 URLs or base64 strings to design mockups or images" },
    "specUrl": { "type": "string", "description": "URL to a specification document" },
    "agent": { 
      "type": "string", 
      "enum": ["Codex", "Antigravity", "Claude"],
      "description": "AI Agent assigned to the task. If this is a subtask (parentId is provided), this MUST match the parent task's agent."
    },
    "model": { 
      "type": "string", 
      "enum": VALID_MODELS,
      "description": "AI Model used for processing"
    },
    "effort": { 
      "type": "string", 
      "enum": ["low", "medium", "high", "xhigh"],
      "description": "Estimated reasoning effort required"
    },
    "parentId": { "type": "string", "description": "ID of the parent task if this is a subtask. If provided, the agent property must match the parent's agent." },
    "reasoning": { "type": "string", "description": "Reasoning or context for this task" },
    "acceptanceCriteria": { "type": "string", "description": "Criteria for accepting the task as done" },
    "verification": { "type": "string", "description": "Steps to verify the task" },
    "repoContext": { "type": "string", "description": "Context about the repository" },
    "jiraKey": { "type": "string", "description": "Jira Issue Key associated with this task" },
    "repo": { "type": "string", "description": "Repository URL" },
    "sourceUrl": { "type": "string", "description": "Original source URL of the task" },
    "createdAt": { "type": "string", "format": "date-time" },
    "updatedAt": { "type": "string", "format": "date-time" },
    "logs": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": { "type": "string" },
          "timestamp": { "type": "string", "format": "date-time" },
          "message": { "type": "string" },
          "type": { "type": "string" }
        },
        "required": ["id", "timestamp", "message", "type"]
      }
    }
  },
  "required": ["title", "projectId"]
};

function validateAgentParams(item: any, tasks: any[]): string | null {
  if (item.agent && !VALID_AGENTS.includes(item.agent)) {
    return `Invalid agent: ${item.agent}. Must be one of: ${VALID_AGENTS.join(', ')}`;
  }
  if (item.effort && !VALID_EFFORTS.includes(item.effort)) {
    return `Invalid effort: ${item.effort}. Must be one of: ${VALID_EFFORTS.join(', ')}`;
  }
  if (item.model && !VALID_MODELS.includes(item.model)) {
    return `Invalid model: ${item.model}. Must be one of: ${VALID_MODELS.join(', ')}`;
  }
  
  if (item.parentId) {
    const parent = tasks.find(t => t.id === item.parentId);
    if (parent && parent.agent && item.agent && item.agent !== parent.agent) {
      return `Subtask must use the same agent as its parent (${parent.agent}).`;
    }
  }
  
  return null;
}



function generateDisplayId(projectId: string, projects: any[]): string {
  const project = projects.find(p => p.id === projectId);
  
  let prefix = 'task';
  if (project && project.taskIdPrefix) {
    prefix = project.taskIdPrefix;
  } else if (project && project.name) {
    prefix = project.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  } else if (projectId && projectId !== 'project-default') {
    prefix = projectId.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  
  if (!prefix) prefix = 'task';

  if (countersCache[prefix] === undefined) {
    let maxNum = 0;
    for (const t of tasksCache) {
      if (t.displayId && t.displayId.startsWith(prefix + '-')) {
        const numPart = t.displayId.split('-').pop();
        if (numPart && !isNaN(parseInt(numPart, 10))) {
          maxNum = Math.max(maxNum, parseInt(numPart, 10));
        }
      }
    }
    countersCache[prefix] = maxNum;
  }
  
  countersCache[prefix] += 1;
  saveCounters();
  
  return `${prefix}-${countersCache[prefix].toString().padStart(4, '0')}`;
}

// Load from projects.json
function loadProjects() {
  try {
    if (fs.existsSync(PROJECTS_FILE)) {
      const data = fs.readFileSync(PROJECTS_FILE, 'utf8');
      projectsCache = JSON.parse(data);
      console.log(`Loaded ${projectsCache.length} projects from projects.json`);
    } else {
      projectsCache = [];
      saveProjects();
      console.log('Seeded initial default project in projects.json');
    }
  } catch (err) {
    console.error('Error reading/writing projects.json, falling back to cache:', err);
    projectsCache = [];
  }
}

// Save back to projects.json
function saveProjects() {
  try {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projectsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('Failed to write to projects.json:', err);
  }
}

// Load from tasks.json
function loadTasks() {
  try {
    loadCounters();
    if (fs.existsSync(DATA_FILE)) {
      const fileData = fs.readFileSync(DATA_FILE, 'utf8');
      tasksCache = JSON.parse(fileData);
      
      // Auto-backfill displayId for existing tasks
      let changed = false;
      tasksCache.forEach((t: any) => {
        if (!t.displayId) {
          t.displayId = generateDisplayId(t.projectId, projectsCache);
          changed = true;
        }
      });
      if (changed) saveTasks();
      console.log(`Loaded ${tasksCache.length} tasks from tasks.json`);
    } else {
      tasksCache = [...SEED_TASKS].map((t: any) => ({
        ...t,
        projectId: 'project-default'
      }));
      tasksCache.forEach((t: any) => {
        if (!t.displayId) {
          t.displayId = generateDisplayId(t.projectId, projectsCache);
        }
      });
      saveTasks();
      console.log('Seeded initial mobile tasks in tasks.json');
    }
  } catch (err) {
    console.error('Error reading/writing tasks.json, falling back to cache:', err);
    tasksCache = [...SEED_TASKS].map((t: any) => ({
      ...t,
      projectId: 'project-default'
    }));
    tasksCache.forEach((t: any) => {
      if (!t.displayId) {
        t.displayId = generateDisplayId(t.projectId, projectsCache);
      }
    });
  }
}

// Save back to tasks.json
function saveTasks() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(tasksCache, null, 2), 'utf8');
    console.log(`[Persistence] Wrote ${tasksCache.length} tasks to ${DATA_FILE}`);
    console.log(`[Persistence] Wrote ${tasksCache.length} tasks to ${DATA_FILE}`);
  } catch (err) {
    console.error('Failed to write to tasks.json:', err);
  }
}

// Resolves repo/repoUrl/projectId to a valid project ID.
// Returns null if absolutely no repo reference or valid project is supplied.
function resolveProjectIdFromRepo(item: any, req: any): string | null {
  const repoInput = item.repo || item.repoUrl || (req.body && req.body.repo) || (req.body && req.body.repoUrl) || (req.query && req.query.repo) || (req.query && req.query.repoUrl) || (req.headers && req.headers['x-repo']) || (req.headers && req.headers['x-repo-url']);
  
  if (!repoInput || typeof repoInput !== 'string' || !repoInput.trim()) {
    if (item.projectId) {
      const found = projectsCache.find(p => p.id === item.projectId);
      if (found) {
        return found.id;
      }
    }
    return null;
  }

  const cleanInput = repoInput.trim().toLowerCase().replace(/\/$/, '');

  // Find matching project
  let project = projectsCache.find(p => {
    const cleanPRepo = p.repoUrl.trim().toLowerCase().replace(/\/$/, '');
    return cleanPRepo === cleanInput || cleanPRepo.includes(cleanInput) || cleanInput.includes(cleanPRepo);
  });

  if (!project) {
    let name = 'Sandbox Project';
    try {
      const urlParts = cleanInput.split('/');
      if (urlParts.length >= 2) {
        const rawName = urlParts[urlParts.length - 1] || urlParts[urlParts.length - 2];
        if (rawName) {
          name = rawName.charAt(0).toUpperCase() + rawName.slice(1);
        }
      }
    } catch (e) {}

    project = {
      id: `project-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      name: `${name} (Auto-Registered)`,
      repoUrl: repoInput.trim(),
      description: 'Automatically registered via API ticket submission',
      createdAt: new Date().toISOString()
    };
    projectsCache.push(project);
    saveProjects();
    console.log(`Auto-created project ${project.name} for repo ${project.repoUrl}`);
  }

  return project.id;
}

async function startServer() {
  loadProjects();
  loadTasks();

  const app = express();
  const PORT = 3000;

  // Use express.json() for /api routes with a larger limit for Base64 images
  app.use('/api', express.json({ limit: '50mb' }));

  // ================= API ENDPOINTS =================

  // ================= SKILLS ENDPOINTS =================
  let SKILLS_REGISTRY: any[] = [];
  const REGISTRY_FILE = path.join(process.cwd(), 'skills', 'registry.json');
  
  function loadSkillsRegistry() {
    try {
      if (fs.existsSync(REGISTRY_FILE)) {
        SKILLS_REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
        SKILLS_REGISTRY.forEach(s => {
          s.filePath = path.join(process.cwd(), 'skills', s.id + '.md');
        });
      }
    } catch (err) {
      console.error('Failed to load skills registry', err);
    }
  }
  
  function saveSkillsRegistry() {
    try {
      const saveList = SKILLS_REGISTRY.map(({id, name, description}) => ({id, name, description}));
      fs.writeFileSync(REGISTRY_FILE, JSON.stringify(saveList, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to save skills registry', err);
    }
  }

  loadSkillsRegistry();

  app.get('/api/skills', (req, res) => {
    res.json(SKILLS_REGISTRY.map(s => ({ id: s.id, name: s.name, description: s.description })));
  });

  app.get('/api/skills/:id', (req, res) => {
    const skill = SKILLS_REGISTRY.find(s => s.id === req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    try {
      const content = fs.existsSync(skill.filePath) ? fs.readFileSync(skill.filePath, 'utf8') : '';
      res.json({ ...skill, content });
    } catch (err) {
      res.status(500).json({ error: 'Failed to read skill' });
    }
  });

  app.put('/api/skills/:id', (req, res) => {
    const skill = SKILLS_REGISTRY.find(s => s.id === req.params.id);
    if (!skill) return res.status(404).json({ error: 'Skill not found' });
    try {
      fs.writeFileSync(skill.filePath, req.body.content || '', 'utf8');
      
      // Update name/description if provided
      if (req.body.name) skill.name = req.body.name;
      if (req.body.description) skill.description = req.body.description;
      saveSkillsRegistry();
      
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Failed to write skill' });
    }
  });

  app.post('/api/skills/import', (req, res) => {
    const { id, name, description, content } = req.body;
    if (!id || !name || !content) return res.status(400).json({ error: 'Missing required fields' });
    
    // Check if ID already exists
    if (SKILLS_REGISTRY.some(s => s.id === id)) {
      return res.status(400).json({ error: 'Skill ID already exists' });
    }

    const filePath = path.join(process.cwd(), 'skills', id + '.md');
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      SKILLS_REGISTRY.push({ id, name, description: description || '', filePath });
      saveSkillsRegistry();
      res.status(201).json({ success: true, id });
    } catch (err) {
      res.status(500).json({ error: 'Failed to import skill' });
    }
  });

  // GET: Fetch all projects
  app.get('/api/projects', (req, res) => {
    res.json(projectsCache);
  });

  // POST: Create a new project
  app.post('/api/projects', (req, res) => {
    const { name, repoUrl, description, localPath, taskIdPrefix } = req.body;
    
    const nameErr = validateString(name, 'name', true);
    if (nameErr) return res.status(400).json({ error: nameErr });
    
    const repoErr = validateString(repoUrl, 'repoUrl', true);
    if (repoErr) return res.status(400).json({ error: repoErr });

    const newProject = {
      id: `project-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
      name: name.trim(),
      repoUrl: repoUrl.trim(),
      description: (description || '').trim(),
      localPath: (localPath || '').trim() || undefined,
      taskIdPrefix: (taskIdPrefix || '').trim() || undefined,
      createdAt: new Date().toISOString()
    };

    projectsCache.push(newProject);
    saveProjects();
    res.status(201).json(newProject);
  });

  // PUT: Update an existing project
  app.put('/api/projects/:id', (req, res) => {
    const projectId = req.params.id;
    const index = projectsCache.findIndex(p => p.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { name, repoUrl, description, localPath, taskIdPrefix } = req.body;
    const project = projectsCache[index];
    
    if (name !== undefined) project.name = name.trim();
    if (repoUrl !== undefined) project.repoUrl = repoUrl.trim();
    if (description !== undefined) project.description = description.trim();
    if (localPath !== undefined) project.localPath = localPath.trim() || undefined;
    if (taskIdPrefix !== undefined) project.taskIdPrefix = taskIdPrefix.trim() || undefined;

    saveProjects();
    res.json(project);
  });

  // DELETE: Remove project & associated tasks
  app.delete('/api/projects/:id', (req, res) => {
    loadTasks();
    const projectId = req.params.id;
    if (projectId === 'project-default') {
      return res.status(400).json({ error: 'Cannot delete default project' });
    }

    const index = projectsCache.findIndex(p => p.id === projectId);
    if (index === -1) {
      return res.status(404).json({ error: 'Project not found' });
    }

    projectsCache.splice(index, 1);
    saveProjects();

    // Clean up tasks in this project
    tasksCache = tasksCache.filter(t => t.projectId !== projectId);
    saveTasks();

    res.json({ success: true, removedId: projectId });
  });

  // GET: Fetch Task JSON Schema
  app.get('/api/schema/task', (req, res) => {
    res.json(TASK_SCHEMA_DEF);
  });

  // GET: Fetch all issues
  app.get('/api/tasks', (req, res) => {
    res.json(tasksCache);
  });

  // GET: App settings
  app.get('/api/settings', (req, res) => {
    res.json(settingsCache);
  });

  // POST: Update App settings
  app.post('/api/settings', (req, res) => {
    const { autoWorking } = req.body;
    if (typeof autoWorking === 'boolean') {
      const wasOff = !settingsCache.autoWorking;
      settingsCache.autoWorking = autoWorking;
      saveSettings();
      
      if (wasOff && autoWorking) {
        writeAgentLog('INFO', 'Auto-work enabled. Scanning for queued ready-to-do tasks...');
        drainReadyToDoQueue();
      }
    }
    res.json(settingsCache);
  });

  // Helper for agent task context
  const getAgentTaskContextLogic = (targetId: string, includeLogs: boolean = false) => {
    loadTasks();
    const task = tasksCache.find(t => t.id === targetId || t.displayId === targetId);
    if (!task) return null;

    const subtasksRaw = tasksCache.filter(t => t.parentId === task.id);
    const parentRaw = task.parentId ? tasksCache.find(t => t.id === task.parentId) : null;
    
    const hasSubtasks = subtasksRaw.length > 0;
    let role = "standalone";
    if (hasSubtasks) role = "parent";
    else if (parentRaw) role = "subtask";

    const project = projectsCache.find(p => p.id === task.projectId);

    const cleanObject = (obj: any) => {
      const cleaned = { ...obj };
      for (const key in cleaned) {
        if (
          cleaned[key] === undefined || 
          cleaned[key] === null || 
          cleaned[key] === '' || 
          (Array.isArray(cleaned[key]) && cleaned[key].length === 0) ||
          (typeof cleaned[key] === 'object' && !Array.isArray(cleaned[key]) && Object.keys(cleaned[key]).length === 0)
        ) {
          delete cleaned[key];
        }
      }
      return cleaned;
    };

    const agentContext: any = {
      task: cleanObject({
        id: task.id,
        displayId: task.displayId,
        title: task.title,
        status: task.status,
        priority: task.priority,
        branch: task.branch
      }),
      assignment: cleanObject({
        agent: task.agent,
        model: task.model,
        effort: task.effort
      }),
      workspace: cleanObject({
        projectId: task.projectId,
        repo: task.repo || project?.repoUrl,
        localPath: project?.localPath
      }),
      instruction: cleanObject({
        description: task.description,
        reasoning: task.reasoning
      }),
      requirements: cleanObject({
        acceptanceCriteria: task.acceptanceCriteria,
        verification: task.verification,
        checklist: task.checklist,
        targetFiles: task.targetFiles
      }),
      repoContext: task.repoContext || undefined,
      orchestration: cleanObject({
        role,
        hasSubtasks,
        subtasks: hasSubtasks ? subtasksRaw.map(st => cleanObject({
          id: st.id,
          displayId: st.displayId,
          title: st.title,
          status: st.status,
          priority: st.priority,
          branch: st.branch,
          spawnAgent: st.agent || 'Antigravity',
          spawnModel: st.model || 'Gemini 3.5 Flash',
          spawnEffort: st.effort || 'medium',
          instruction: cleanObject({
            description: st.description,
            reasoning: st.reasoning
          }),
          acceptanceCriteria: st.acceptanceCriteria,
          verification: st.verification,
          checklist: st.checklist,
          targetFiles: st.targetFiles
        })) : undefined,
        parentBoundary: parentRaw ? cleanObject({
          id: parentRaw.id,
          displayId: parentRaw.displayId,
          title: parentRaw.title,
          status: parentRaw.status,
          branch: parentRaw.branch,
          instruction: cleanObject({
            description: parentRaw.description
          })
        }) : undefined
      })
    };

    if (includeLogs) {
      agentContext.logs = task.logs;
    }
    
    if (!agentContext.repoContext) delete agentContext.repoContext;
    if (Object.keys(agentContext.requirements).length === 0) delete agentContext.requirements;
    if (Object.keys(agentContext.assignment).length === 0) delete agentContext.assignment;

    return agentContext;
  };

  // GET: Fetch clean agent-ready task context
  app.get('/api/tasks/:id/agent-context', (req, res) => {
    const targetId = req.params.id;
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    
    const context = getAgentTaskContextLogic(targetId, includeLogs);
    if (!context) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(context);
  });

  // GET: Build the compiled prompt
  app.get('/api/tasks/:id/prompt', (req, res) => {
    const targetId = req.params.id;
    const includeLogs = req.query.includeLogs === 'true' || req.query.mode === 'full' || req.query.mode === 'debug';
    
    const context = getAgentTaskContextLogic(targetId, includeLogs);
    if (!context) {
      return res.status(404).json({ error: 'Task not found' });
    }

    let promptContent = "";

    // Load prompt-template skill
    const promptTemplateSkill = SKILLS_REGISTRY.find(s => s.id === 'prompt-template');
    if (promptTemplateSkill && fs.existsSync(promptTemplateSkill.filePath)) {
      promptContent = fs.readFileSync(promptTemplateSkill.filePath, 'utf8');
    } else {
      // Fallback
      promptContent = `You are an AI developer agent. A task has been assigned to you in Dev Flow. Task ID: {TASK_ID}. Step 1: Immediately use the Dev Flow MCP tool to move this task to 'in-progress' status. Step 2: Read the task details. Step 3: If the task has checklist items or subtasks, use the invoke_subagent tool to call subagents for them. Step 4: When done, move the task to 'ready-for-review'. Step 5: Check if there are any other tasks in the 'todo' lane for this project. If there are, pick the oldest one, move it to 'in-progress', work on it, and repeat this loop until no 'todo' tasks remain.\n\n### Task Context\n{TASK_CONTEXT}\n\n{AGENT_WORKFLOW}`;
    }

    // Load agent-specific workflow skill
    const agentId = context.assignment?.agent?.toLowerCase() || 'default';
    const agentWorkflowSkill = SKILLS_REGISTRY.find(s => s.id === `agent-${agentId}-workflow`);
    let agentWorkflowContent = "";
    if (agentWorkflowSkill && fs.existsSync(agentWorkflowSkill.filePath)) {
      agentWorkflowContent = fs.readFileSync(agentWorkflowSkill.filePath, 'utf8');
    }

    // Replace placeholders
    promptContent = promptContent.replace(/\{TASK_ID\}/g, context.task.id);
    promptContent = promptContent.replace(/\{TASK_CONTEXT\}/g, JSON.stringify(context, null, 2));
    promptContent = promptContent.replace(/\{AGENT_WORKFLOW\}/g, agentWorkflowContent);

    // Return as plain text
    res.setHeader('Content-Type', 'text/plain');
    res.send(promptContent);
  });

  // POST: Create a new issue card (supports single object or JSON Array of tasks for batch creation)
  app.post('/api/tasks', (req, res) => {
    loadTasks();
    let rawItems = req.body;
    
    // Support outer layer { repo: "", tasks: [] }
    let outerRepo: string | null = null;
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
      if (Array.isArray(rawItems.tasks)) {
        outerRepo = rawItems.repo || rawItems.repoUrl;
        rawItems = rawItems.tasks.map((taskItem: any) => {
          if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
            return { ...taskItem, repo: outerRepo };
          }
          return taskItem;
        });
      } else if (rawItems.parent && Array.isArray(rawItems.children)) {
        // Support { parent: {...}, children: [...] }
        const parentTask = { ...rawItems.parent };
        const childrenTasks = [...rawItems.children];
        
        const parentGenId = `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
        parentTask._internalId = parentGenId;
        
        const assignedChildren = childrenTasks.map((c: any) => ({
          ...c,
          parentId: parentGenId,
          agent: c.agent || parentTask.agent // Auto-inherit agent
        }));
        rawItems = [parentTask, ...assignedChildren];
      }
    }

    const isArray = Array.isArray(rawItems);
    if (!isArray) {
      if (rawItems && typeof rawItems === 'object') {
        rawItems = [rawItems];
      } else {
        return res.status(400).json({ error: 'Request body must be a JSON object or a JSON array of tasks' });
      }
    }

    if (rawItems.length === 0) {
      return res.status(400).json({ error: 'Tasks list is empty' });
    }

    const createdTasks: any[] = [];
    for (const item of rawItems) {
      const validationErr = validateTaskPayload(item, false);
      if (validationErr) {
        if (!isArray) return res.status(400).json({ error: validationErr });
        continue; // Skip invalid items in batch array
      }

      const title = item.title;
      const resolvedProjectId = resolveProjectIdFromRepo(item, req);
      if (!resolvedProjectId) {
        return res.status(400).json({ error: "Repository identifier ('repo' or 'repoUrl') is required to write a task" });
      }

      const agentValidationError = validateAgentParams(item, tasksCache);
      if (agentValidationError) {
        if (!isArray) return res.status(400).json({ error: agentValidationError });
        continue;
      }

      const newTask = {
        id: item._internalId || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
        displayId: generateDisplayId(resolvedProjectId, projectsCache),
        projectId: resolvedProjectId,
        title: title.trim(),
        description: item.description || '',
        status: item.status || 'backlog',
        branch: item.branch || undefined,
        priority: item.priority || 'medium',
        tags: Array.isArray(item.tags) ? item.tags : [],
        targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
        checklist: Array.isArray(item.checklist) ? item.checklist : [],
        designImages: extractDesignImages(item) || [],
        specUrl: item.specUrl || undefined,
        agent: item.agent || undefined,
        model: item.model || undefined,
        parentId: item.parentId || undefined,
        effort: item.effort || undefined,
        reasoning: item.reasoning || undefined,
        acceptanceCriteria: item.acceptanceCriteria || undefined,
        verification: item.verification || undefined,
        repoContext: item.repoContext || undefined,
        createdAt: item.createdAt || new Date().toISOString(),
        updatedAt: item.updatedAt || new Date().toISOString(),
        logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [
          {
            id: `log-${Date.now()}-c`,
            timestamp: new Date().toISOString(),
            message: item.parentId 
              ? `Subtask initialized under parent task ${item.parentId} via Workspace API.`
              : 'Task initialized via Workspace API.',
            type: 'create'
          }
        ]
      };

      tasksCache.push(newTask);
      createdTasks.push(newTask);
    }

    saveTasks();

    if (isArray) {
      res.status(201).json({ success: true, createdCount: createdTasks.length, tasks: createdTasks });
    } else {
      res.status(201).json(createdTasks[0]);
    }
  });

  // POST: Bulk / Batch creation and write updates of multiple task cards via JSON array (Upsert)
  app.post('/api/tasks/batch', (req, res) => {
    loadTasks();
    let rawItems = req.body;
    
    // Support outer layer { repo: "", tasks: [] }
    let outerRepo: string | null = null;
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
      if (Array.isArray(rawItems.tasks)) {
        outerRepo = rawItems.repo || rawItems.repoUrl;
        rawItems = rawItems.tasks.map((taskItem: any) => {
          if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
            return { ...taskItem, repo: outerRepo };
          }
          return taskItem;
        });
      }
    }

    // Support either a single card object or an array of cards
    if (!Array.isArray(rawItems)) {
      if (rawItems && typeof rawItems === 'object') {
        rawItems = [rawItems];
      } else {
        return res.status(400).json({ error: 'Request body must be a JSON array or a Task object' });
      }
    }

    if (rawItems.length === 0) {
      return res.status(400).json({ error: 'Batch array is empty' });
    }

    const importedTasks: any[] = [];
    const updatedTasks: any[] = [];

    for (const item of rawItems) {
      const existingIndex = item.id ? tasksCache.findIndex(t => t.id === item.id) : -1;
      const isUpdate = existingIndex !== -1;
      
      const validationErr = validateTaskPayload(item, isUpdate);
      if (validationErr) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: validationErr });
        continue;
      }
      
      const title = item.title;

      const agentValidationError = validateAgentParams(item, tasksCache);
      if (agentValidationError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: agentValidationError });
        continue;
      }

      if (existingIndex !== -1) {
        // Update existing task (Upsert Write)
        const currentTask = tasksCache[existingIndex];

        // Enforce lock
        if (currentTask.status === 'in-progress') {
          const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
          const isEmergency = item.emergency === true || String(item.emergency).toLowerCase() === 'true';
          if (!isAgentRequest && !isEmergency) {
            continue;
          }
        }

        const updatedTask = {
          ...currentTask,
          title: title !== undefined ? String(title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          tags: Array.isArray(item.tags) ? item.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
          specUrl: item.specUrl !== undefined ? item.specUrl : currentTask.specUrl,
          agent: item.agent !== undefined ? item.agent : currentTask.agent,
          model: item.model !== undefined ? item.model : currentTask.model,
          parentId: item.parentId !== undefined ? item.parentId : currentTask.parentId,
          effort: item.effort !== undefined ? item.effort : currentTask.effort,
          reasoning: item.reasoning !== undefined ? item.reasoning : currentTask.reasoning,
          acceptanceCriteria: item.acceptanceCriteria !== undefined ? item.acceptanceCriteria : currentTask.acceptanceCriteria,
          verification: item.verification !== undefined ? item.verification : currentTask.verification,
          repoContext: item.repoContext !== undefined ? item.repoContext : currentTask.repoContext,
          updatedAt: new Date().toISOString(),
          logs: [
            ...(currentTask.logs || []),
            {
              id: `log-${Date.now()}-ut-${Math.floor(Math.random() * 1000000)}`,
              timestamp: new Date().toISOString(),
              message: 'Task updated in Batch write mode.',
              type: 'update'
            }
          ]
        };

        if (['backlog', 'done', 'ready-for-review'].includes(updatedTask.status)) {
          updatedTask.activeAgent = undefined;
        }

        tasksCache[existingIndex] = updatedTask;
        updatedTasks.push(updatedTask);
      } else {
        // Create new task
        const resolvedProjectId = resolveProjectIdFromRepo(item, req);
        if (!resolvedProjectId) {
          return res.status(400).json({ error: "Repository identifier ('repo' or 'repoUrl') is required to write a task" });
        }

        const newTask = {
          id: item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          displayId: item.displayId || generateDisplayId(resolvedProjectId, projectsCache),
          projectId: resolvedProjectId,
          title: title.trim(),
          description: item.description || '',
          status: item.status || 'backlog',
          branch: item.branch || undefined,
          priority: item.priority || 'medium',
          tags: Array.isArray(item.tags) ? item.tags : [],
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
          checklist: Array.isArray(item.checklist) ? item.checklist : [],
          designImages: extractDesignImages(item) || [],
          specUrl: item.specUrl || undefined,
          agent: item.agent || undefined,
          model: item.model || undefined,
          parentId: item.parentId || undefined,
          effort: item.effort || undefined,
          reasoning: item.reasoning || undefined,
          acceptanceCriteria: item.acceptanceCriteria || undefined,
          verification: item.verification || undefined,
          repoContext: item.repoContext || undefined,
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString(),
          logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [
            {
              id: `log-${Date.now()}-ct`,
              timestamp: new Date().toISOString(),
              message: 'Task created in Batch mode.',
              type: 'create'
            }
          ]
        };
        tasksCache.push(newTask);
        importedTasks.push(newTask);
      }
    }

    saveTasks();
    res.status(201).json({ 
      success: true, 
      createdCount: importedTasks.length, 
      updatedCount: updatedTasks.length, 
      tasks: [...importedTasks, ...updatedTasks] 
    });
  });

  // POST: Custom API endpoint to move/transition an issue card status (called by external scripts or webhooks)
  app.post('/api/tasks/:id/move', (req, res) => {
    loadTasks();
    const targetId = req.params.id;
    const { status } = req.body;
    
    const statusErr = validateEnum(status, 'status', VALID_STATUSES, true);
    if (statusErr) return res.status(400).json({ error: statusErr });

    const taskIndex = tasksCache.findIndex(t => t.id === targetId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = tasksCache[taskIndex];
    const prevStatus = task.status;
    
    if (prevStatus === status) {
      return res.json({ message: 'Task is already in that lane', task });
    }

    // Enforce lock
    if (prevStatus === 'in-progress') {
      const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
      const isEmergency = req.body.emergency === true || String(req.body.emergency).toLowerCase() === 'true';
      if (!isAgentRequest && !isEmergency) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }
    }

    const updatedTask = {
      ...task,
      status: status,
      updatedAt: new Date().toISOString(),
      logs: [
        ...task.logs,
        {
          id: `log-ext-move-${Date.now()}`,
          timestamp: new Date().toISOString(),
          message: `Status moved from ${prevStatus.toUpperCase()} to ${status.toUpperCase()} via External API Call`,
          type: 'move'
        }
      ]
    };

    if (['backlog', 'done', 'ready-for-review'].includes(status)) {
      updatedTask.activeAgent = undefined;
    }

    // Trigger Agent
    if (status === 'todo' && prevStatus !== 'todo') {
      if (!settingsCache.autoWorking) {
        writeAgentLog('INFO', `Auto-work is disabled. Skipping automatic agent trigger for task=${updatedTask.id}`);
      } else if (updatedTask.agent && !updatedTask.activeAgent) {
        const isAgentBusy = tasksCache.some(t => 
          t.projectId === updatedTask.projectId && 
          (t.status === 'in-progress' || t.status === 'todo') && 
          t.activeAgent && 
          t.id !== updatedTask.id
        );

        if (!isAgentBusy) {
          updatedTask.activeAgent = updatedTask.agent;
          if (/^[a-zA-Z0-9-]+$/.test(updatedTask.agent) && /^[a-zA-Z0-9-]+$/.test(updatedTask.id)) {
            const triggerBat = path.join(process.cwd(), 'trigger-agent.bat');
            const proj = projectsCache.find(p => p.id === updatedTask.projectId);
            const execOpts = proj?.localPath ? { cwd: proj.localPath } : undefined;
            const safeLocalPath = `"${proj?.localPath || 'none'}"`;
            const safeModel = `"${updatedTask.model || 'none'}"`;
            const safeEffort = `"${updatedTask.effort || 'none'}"`;
            
            writeAgentLog('TRIGGER', `Spawning agent=${updatedTask.agent} for task=${updatedTask.id} ("${updatedTask.title}") via /move endpoint${execOpts ? ' at ' + execOpts.cwd : ''}`);
            execFile('cmd.exe', ['/c', triggerBat, updatedTask.agent, updatedTask.id, safeLocalPath, safeModel, safeEffort], execOpts, (err) => {
              if (err) writeAgentLog('ERROR', `trigger-agent.bat failed for task=${updatedTask.id}: ${err.message}`);
              else writeAgentLog('INFO', `trigger-agent.bat exited OK for task=${updatedTask.id}`);
            });
          } else {
            writeAgentLog('ERROR', `Blocked trigger due to invalid chars: agent=${updatedTask.agent} taskId=${updatedTask.id}`);
          }
        } else {
          writeAgentLog('INFO', `Agent already busy for project=${updatedTask.projectId}, skipping trigger for task=${updatedTask.id}`);
        }
      }
    }

    tasksCache[taskIndex] = updatedTask;
    saveTasks();
    res.json({ success: true, message: `Successfully relocated task schema from ${prevStatus} to ${status}`, task: updatedTask });
  });

  // POST: Specific API endpoint to toggle a checklist item's completion status
  app.post('/api/tasks/:id/checklist/toggle', (req, res) => {
    loadTasks();
    const targetId = req.params.id;
    const { checklistId } = req.body;
    
    const checklistErr = validateString(checklistId, 'checklistId', true);
    if (checklistErr) return res.status(400).json({ error: checklistErr });

    const taskIndex = tasksCache.findIndex(t => t.id === targetId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = tasksCache[taskIndex];
    const checklist = task.checklist || [];
    const item = checklist.find((c: any) => (c.id || c.text) === checklistId);
    
    if (!item) {
      return res.status(404).json({ error: 'Checklist item not found' });
    }

    // Enforce lock
    if (task.status === 'in-progress') {
      const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
      const isEmergency = req.body.emergency === true || String(req.body.emergency).toLowerCase() === 'true';
      if (!isAgentRequest && !isEmergency) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }
    }

    item.completed = !item.completed;
    task.updatedAt = new Date().toISOString();
    task.logs = [
      ...task.logs,
      {
        id: `log-chk-toggle-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Checklist step "${item.text}" set to ${item.completed ? 'COMPLETED' : 'INCOMPLETE'} via Specific API`,
        type: 'update'
      }
    ];

    saveTasks();
    res.json(task);
  });

  // POST: Specific API endpoint to assign agent, model and effort to a card
  app.post('/api/tasks/:id/assign', (req, res) => {
    loadTasks();
    const targetId = req.params.id;
    const { agent, model, effort } = req.body;

    const agentErr = validateEnum(agent, 'agent', VALID_AGENTS, false);
    if (agentErr) return res.status(400).json({ error: agentErr });
    
    const modelErr = validateEnum(model, 'model', VALID_MODELS, false);
    if (modelErr) return res.status(400).json({ error: modelErr });
    
    const effortErr = validateEnum(effort, 'effort', VALID_EFFORTS, false);
    if (effortErr) return res.status(400).json({ error: effortErr });

    const taskIndex = tasksCache.findIndex(t => t.id === targetId);
    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const task = tasksCache[taskIndex];

    // Enforce lock
    if (task.status === 'in-progress') {
      const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
      const isEmergency = req.body.emergency === true || String(req.body.emergency).toLowerCase() === 'true';
      if (!isAgentRequest && !isEmergency) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }
    }

    task.agent = agent || undefined;
    task.model = model || undefined;
    task.effort = effort || undefined;
    task.updatedAt = new Date().toISOString();
    task.logs = [
      ...task.logs,
      {
        id: `log-assign-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Agent configuration updated: Agent=${agent || 'None'}, Model=${model || 'Default'}, Effort=${effort || 'Auto'} via Specific API`,
        type: 'update'
      }
    ];

    saveTasks();
    res.json(task);
  });

  // PUT: Batch / List updates and upsert of multiple task cards via JSON array from the very beginning
  app.put('/api/tasks', (req, res) => {
    loadTasks();
    let rawItems = req.body;
    
    // Support outer layer { repo: "", tasks: [] }
    let outerRepo: string | null = null;
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
      if (Array.isArray(rawItems.tasks)) {
        outerRepo = rawItems.repo || rawItems.repoUrl;
        rawItems = rawItems.tasks.map((taskItem: any) => {
          if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
            return { ...taskItem, repo: outerRepo };
          }
          return taskItem;
        });
      }
    }

    // Support either a single card object or an array of cards
    if (!Array.isArray(rawItems)) {
      if (rawItems && typeof rawItems === 'object') {
        rawItems = [rawItems];
      } else {
        return res.status(400).json({ error: 'Request body must be a JSON array or a Task object' });
      }
    }

    if (rawItems.length === 0) {
      return res.status(400).json({ error: 'Tasks list is empty' });
    }

    const importedTasks: any[] = [];
    const updatedTasks: any[] = [];

    for (const item of rawItems) {
      const existingIndex = item.id ? tasksCache.findIndex(t => t.id === item.id) : -1;
      const isUpdate = existingIndex !== -1;
      
      const validationErr = validateTaskPayload(item, isUpdate);
      if (validationErr) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: validationErr });
        continue;
      }
      
      const title = item.title;

      const agentValidationError = validateAgentParams(item, tasksCache);
      if (agentValidationError) {
        if (!Array.isArray(req.body)) return res.status(400).json({ error: agentValidationError });
        continue;
      }

      if (existingIndex !== -1) {
        // Update existing task (Upsert Write)
        const currentTask = tasksCache[existingIndex];

        // Enforce lock
        if (currentTask.status === 'in-progress') {
          const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
          const isEmergency = item.emergency === true || String(item.emergency).toLowerCase() === 'true';
          if (!isAgentRequest && !isEmergency) {
            continue;
          }
        }

        const updatedTask = {
          ...currentTask,
          title: title !== undefined ? String(title).trim() : currentTask.title,
          description: item.description !== undefined ? item.description : currentTask.description,
          status: item.status !== undefined ? item.status : currentTask.status,
          branch: item.branch !== undefined ? item.branch : currentTask.branch,
          priority: item.priority !== undefined ? item.priority : currentTask.priority,
          tags: Array.isArray(item.tags) ? item.tags : currentTask.tags,
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : currentTask.targetFiles,
          checklist: Array.isArray(item.checklist) ? item.checklist : currentTask.checklist,
          designImages: extractDesignImages(item, currentTask) || [],
          specUrl: item.specUrl !== undefined ? item.specUrl : currentTask.specUrl,
          agent: item.agent !== undefined ? item.agent : currentTask.agent,
          model: item.model !== undefined ? item.model : currentTask.model,
          parentId: item.parentId !== undefined ? item.parentId : currentTask.parentId,
          effort: item.effort !== undefined ? item.effort : currentTask.effort,
          updatedAt: new Date().toISOString(),
          logs: [
            ...(currentTask.logs || []),
            {
              id: `log-${Date.now()}-ut-${Math.floor(Math.random() * 1000000)}`,
              timestamp: new Date().toISOString(),
              message: 'Task updated in Batch list PUT mode.',
              type: 'update'
            }
          ]
        };

        if (['backlog', 'done', 'ready-for-review'].includes(updatedTask.status)) {
          updatedTask.activeAgent = undefined;
        }

        tasksCache[existingIndex] = updatedTask;
        updatedTasks.push(updatedTask);
      } else {
        // Create new task
        const resolvedProjectId = resolveProjectIdFromRepo(item, req);
        if (!resolvedProjectId) {
          return res.status(400).json({ error: "Repository identifier ('repo' or 'repoUrl') is required to write a task" });
        }

        const newTask = {
          id: item.id || `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          displayId: item.displayId || generateDisplayId(resolvedProjectId, projectsCache),
          projectId: resolvedProjectId,
          title: title.trim(),
          description: item.description || '',
          status: item.status || 'backlog',
          branch: item.branch || undefined,
          priority: item.priority || 'medium',
          tags: Array.isArray(item.tags) ? item.tags : [],
          targetFiles: Array.isArray(item.targetFiles) ? item.targetFiles : [],
          checklist: Array.isArray(item.checklist) ? item.checklist : [],
          designImages: extractDesignImages(item) || [],
          specUrl: item.specUrl || undefined,
          agent: item.agent || undefined,
          model: item.model || undefined,
          parentId: item.parentId || undefined,
          effort: item.effort || undefined,
          createdAt: item.createdAt || new Date().toISOString(),
          updatedAt: item.updatedAt || new Date().toISOString(),
          logs: Array.isArray(item.logs) && item.logs.length > 0 ? item.logs : [
            {
              id: `log-${Date.now()}-ct`,
              timestamp: new Date().toISOString(),
              message: 'Task created via Batch list PUT mode.',
              type: 'create'
            }
          ]
        };
        tasksCache.push(newTask);
        importedTasks.push(newTask);
      }
    }

    saveTasks();
    res.status(200).json({ 
      success: true, 
      createdCount: importedTasks.length, 
      updatedCount: updatedTasks.length, 
      tasks: [...importedTasks, ...updatedTasks] 
    });
  });

  // PUT: Update an issue card (such as step counts, state lanes, specs)
  app.put('/api/tasks/:id', (req, res) => {
    loadTasks();
    const targetId = req.params.id;
    const taskIndex = tasksCache.findIndex(t => t.id === targetId);

    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const currentTask = tasksCache[taskIndex];
    let updateBody = req.body;

    // Enforce lock
    if (currentTask.status === 'in-progress') {
      const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
      const isEmergency = req.body.emergency === true || String(req.body.emergency).toLowerCase() === 'true';
      if (!isAgentRequest && !isEmergency) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }
    }

    const validationErr = validateTaskPayload(updateBody, true);
    if (validationErr) {
      return res.status(400).json({ error: validationErr });
    }

    const resolvedProjectId = resolveProjectIdFromRepo(updateBody, req);
    if (resolvedProjectId) {
      updateBody = { ...updateBody, projectId: resolvedProjectId };
    }

    const agentValidationError = validateAgentParams(updateBody, tasksCache);
    if (agentValidationError) {
      return res.status(400).json({ error: agentValidationError });
    }

    const updatedTask = {
      ...currentTask,
      ...updateBody,
      designImages: extractDesignImages(updateBody, currentTask) || [],
      updatedAt: new Date().toISOString()
    };

    if (['backlog', 'done', 'ready-for-review'].includes(updatedTask.status)) {
      updatedTask.activeAgent = undefined;
    }

    // Trigger Agent
    if (updatedTask.status === 'todo' && currentTask.status !== 'todo') {
      if (!settingsCache.autoWorking) {
        writeAgentLog('INFO', `Auto-work is disabled. Skipping automatic agent trigger for task=${updatedTask.id}`);
      } else if (updatedTask.agent && !updatedTask.activeAgent) {
        const isAgentBusy = tasksCache.some(t => 
          t.projectId === updatedTask.projectId && 
          (t.status === 'in-progress' || t.status === 'todo') && 
          t.activeAgent && 
          t.id !== updatedTask.id
        );

        if (!isAgentBusy) {
          updatedTask.activeAgent = updatedTask.agent;
          if (/^[a-zA-Z0-9-]+$/.test(updatedTask.agent) && /^[a-zA-Z0-9-]+$/.test(updatedTask.id)) {
            const triggerBat = path.join(process.cwd(), 'trigger-agent.bat');
            const proj = projectsCache.find(p => p.id === updatedTask.projectId);
            const execOpts = proj?.localPath ? { cwd: proj.localPath } : undefined;
            const safeLocalPath = `"${proj?.localPath || 'none'}"`;
            const safeModel = `"${updatedTask.model || 'none'}"`;
            const safeEffort = `"${updatedTask.effort || 'none'}"`;

            writeAgentLog('TRIGGER', `Spawning agent=${updatedTask.agent} for task=${updatedTask.id} ("${updatedTask.title}") via PUT /tasks/:id endpoint${execOpts ? ' at ' + execOpts.cwd : ''}`);
            execFile('cmd.exe', ['/c', triggerBat, updatedTask.agent, updatedTask.id, safeLocalPath, safeModel, safeEffort], execOpts, (err) => {
              if (err) writeAgentLog('ERROR', `trigger-agent.bat failed for task=${updatedTask.id}: ${err.message}`);
              else writeAgentLog('INFO', `trigger-agent.bat exited OK for task=${updatedTask.id}`);
            });
          } else {
            writeAgentLog('ERROR', `Blocked trigger due to invalid chars: agent=${updatedTask.agent} taskId=${updatedTask.id}`);
          }
        } else {
          writeAgentLog('INFO', `Agent already busy for project=${updatedTask.projectId}, skipping trigger for task=${updatedTask.id}`);
        }
      }
    }

    tasksCache[taskIndex] = updatedTask;
    saveTasks();
    res.json(updatedTask);
  });

  // DELETE: Terminate an issue card
  app.delete('/api/tasks/:id', (req, res) => {
    loadTasks();
    const targetId = req.params.id;
    const taskIndex = tasksCache.findIndex(t => t.id === targetId);

    if (taskIndex === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const currentTask = tasksCache[taskIndex];
    // Enforce lock
    if (currentTask.status === 'in-progress') {
      const isAgentRequest = String(req.headers['x-agent-request']).toLowerCase() === 'true';
      // For DELETE, emergency might be passed in body or query depending on usage
      const isEmergency = req.body?.emergency === true || String(req.body?.emergency).toLowerCase() === 'true' || String(req.query?.emergency).toLowerCase() === 'true';
      if (!isAgentRequest && !isEmergency) {
        return res.status(403).json({ error: 'Task is locked by an agent. Use emergency flag to override.' });
      }
    }

    const removed = tasksCache.splice(taskIndex, 1);
    saveTasks();
    res.json({ success: true, removed: removed[0] });
  });

  // POST: Reset back to initial seeds
  app.post('/api/tasks/reset', (req, res) => {
    loadTasks();
    tasksCache = [...SEED_TASKS].map(t => ({
      ...t,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));
    saveTasks();
    res.json({ success: true, count: tasksCache.length });
  });

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

        const pId = String(args?.projectId || "project-default");
        const newTask = {
          id: `task-${Date.now()}-${Math.floor(Math.random() * 1000000)}`,
          displayId: generateDisplayId(pId, projectsCache),
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
