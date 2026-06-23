import { executeAllMigrations } from '../db/migrations/index.js';
import fs from 'fs';

import {
  generateDisplayId as generateTaskDisplayId,
  loadTasks as hydrateTasks,
  saveTasks as persistTasks,
} from './repositories/taskRepository.js';
import { loadSkillsRegistry } from './repositories/skillsRepository.js';
import type { AppState } from './types.js';
import { resolveFromDevFlowAppRoot } from '../lib/devFlowPaths.js';

export const AGENT_LOG_FILE = resolveFromDevFlowAppRoot('logs', 'agent-trigger.log');

export type AgentLogLevel = 'INFO' | 'ERROR' | 'TRIGGER';

export function writeAgentLog(level: AgentLogLevel, message: string): void {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(AGENT_LOG_FILE, entry, 'utf8');
  } catch (err) {
    console.error('[agent-log] Failed to write log:', err);
  }
  console.log(entry.trim());
}

export interface AppStateSeed {
  tasksCache: any[];
  
  countersCache: Record<string, number>;
  skillsRegistry: any[];
}

export function createAppState(): AppState {
  const tasksCache: any[] = [];
  
  const countersCache: Record<string, number> = {};
  const skillsRegistry: any[] = [];
  return {
    get tasksCache() {
      return tasksCache;
    },
    set tasksCache(value) {
      tasksCache.length = 0;
      tasksCache.push(...value);
    },
    
    get countersCache() {
      return countersCache;
    },
    set countersCache(value) {
      for (const k of Object.keys(countersCache)) delete countersCache[k];
      Object.assign(countersCache, value);
    },
    get skillsRegistry() {
      return skillsRegistry;
    },
    set skillsRegistry(value) {
      skillsRegistry.length = 0;
      skillsRegistry.push(...value);
    },
  } as AppState;
}





export function loadTasks(state: AppState) {
  hydrateTasks(state);
}

export function saveTasks(state: AppState) {
  persistTasks(state);
}

export function loadSkills(state: AppState) {
  loadSkillsRegistry(state);
}

export function generateDisplayId(state: AppState, projectId: string) {
  return generateTaskDisplayId(state, projectId);
}

export function sanitizeStartupTasks(state: AppState): void {
  let changed = false;
  for (const task of state.tasksCache) {
    if (task.status === 'in-progress' && !task.activeAgent) {
      task.status = 'todo';
      changed = true;
    }
  }
  if (changed) saveTasks(state);
}

export interface BootstrapResult {
  state: AppState;
  writeAgentLog: (level: AgentLogLevel, message: string) => void;
  generateDisplayId: (projectId: string) => string;
}

export function bootstrap(): BootstrapResult {
  executeAllMigrations();
  const state = createAppState();
  loadTasks(state);
  loadSkills(state);
  sanitizeStartupTasks(state);
  return {
    state,
    writeAgentLog,
    generateDisplayId: (projectId: string) => generateDisplayId(state, projectId),
  };
}
