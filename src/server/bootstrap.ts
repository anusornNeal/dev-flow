import { executeAllMigrations } from '../db/migrations/index.js';
import fs from 'fs';

import {
  generateDisplayId as generateTaskDisplayId,
  getTasks,
  saveTask
} from './repositories/taskRepository.js';
import { initSkillsRepository } from './repositories/skillsRepository.js';
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
  countersCache: Record<string, number>;
}

export function createAppState(): AppState {
  const countersCache: Record<string, number> = {};
  
  return {
    get countersCache() {
      return countersCache;
    },
    set countersCache(value) {
      for (const k of Object.keys(countersCache)) delete countersCache[k];
      Object.assign(countersCache, value);
    },
  } as AppState;
}

export function generateDisplayId(state: AppState, projectId: string) {
  return generateTaskDisplayId(state, projectId);
}

export function sanitizeStartupTasks(state: AppState): void {
  const tasks = getTasks();
  for (const task of tasks) {
    if (task.status === 'in-progress' && !task.activeAgent) {
      task.status = 'todo';
      saveTask(task);
    }
  }
}

export interface BootstrapResult {
  state: AppState;
  writeAgentLog: (level: AgentLogLevel, message: string) => void;
  generateDisplayId: (projectId: string) => string;
}

export function bootstrap(): BootstrapResult {
  executeAllMigrations();
  initSkillsRepository();
  const state = createAppState();
  sanitizeStartupTasks(state);
  return {
    state,
    writeAgentLog,
    generateDisplayId: (projectId: string) => generateDisplayId(state, projectId),
  };
}
