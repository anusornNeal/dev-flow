/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  VALID_BUG_SEVERITIES,
  VALID_BUG_SOURCES,
  VALID_BUG_STATUSES,
  VALID_STATUSES,
  VALID_PRIORITIES,
  type BugSeverity,
  type BugSource,
  type BugStatus,
  type TaskStatus,
  type TaskPriority,
} from './server/domain/task.js';

// Re-export domain types so existing imports keep working, but the source of truth is now src/server/domain/task.ts.
export { VALID_BUG_SEVERITIES, VALID_BUG_SOURCES, VALID_BUG_STATUSES, VALID_STATUSES, VALID_PRIORITIES } from './server/domain/task.js';
export type { BugSeverity, BugSource, BugStatus, TaskStatus, TaskPriority } from './server/domain/task.js';
export type TaskCategory = 'frontend' | 'backend' | 'general';

export interface LogEntry {
  id: string;
  timestamp: string;
  message: string;
  type: 'create' | 'move' | 'edit' | 'comment';
}

export interface ChecklistItem {
  id: string;
  text: string;
  completed: boolean;
}

export type AgentCompletionStatus = 'success' | 'failed' | 'cancelled';
export type AgentCompletionTestResult = 'passed' | 'failed' | 'not-run';

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
}

export interface TaskImage {
  id: string;
  filename: string;
  url: string;
  absolutePath: string;
  createdAt: string;
}

export interface AgentCompletionTest {
  command: string;
  result: AgentCompletionTestResult;
  output?: string;
}

export interface AgentCompletionPayload {
  runId?: string;
  status: AgentCompletionStatus;
  summary: string;
  changedFiles?: string[];
  tests?: AgentCompletionTest[];
  notes?: string;
  moveTo?: Exclude<TaskStatus, 'done'>;
}

export interface BugVersion {
  version: number;
  status: BugStatus;
  prompt: string;
  summary?: string;
  changedFiles?: string[];
  createdAt: string;
  createdBy?: string;
}

export interface BugThread {
  id: string;
  taskId: string;
  title: string;
  status: BugStatus;
  source: BugSource;
  severity: BugSeverity;
  actual?: string;
  expected?: string;
  evidence?: string;
  relatedAreas?: string[];
  versions: BugVersion[];
  createdAt: string;
  updatedAt: string;
}

export interface Task {
  id: string;
  displayId?: string; // e.g. buddy2-0001
  projectId?: string; // Links to a specific Project
  title: string;
  description: string;
  status: TaskStatus;
  branch?: string;
  priority: TaskPriority;
  category?: TaskCategory;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  logs: LogEntry[];
  targetFiles?: string[];
  checklist?: ChecklistItem[];
  bugs?: BugThread[];
  repoContext?: string;
  specUrl?: string;
  images?: TaskImage[]; // New unlimited local image storage
  jiraKey?: string;
  sourceUrl?: string; // Specification link or text
  agent?: string; // Codex | Antigravity | Claude
  activeAgent?: string; // Currently working agent
  latestAgentRun?: {
    id: string;
    status: 'queued' | 'starting' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    agent: string;
    errorMessage?: string | null;
    createdAt: string;
    startedAt?: string | null;
    endedAt?: string | null;
  };
  agentRuns?: {
    id: string;
    status: string;
    logFile?: string | null;
  }[];
  model?: string; // Model name
  parentId?: string; // ID of the parent task if this is a subtask
  effort?: string; // Effort level (varies by agent and model)
  reasoning?: string;
  acceptanceCriteria?: string;
  verification?: string;
  repo?: string;
}

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  description?: string;
  localPath?: string; // Absolute path to the local project directory
  taskIdPrefix?: string; // Custom prefix for task display IDs (e.g. DVF)
  createdAt: string;
}

export interface Column {
  id: TaskStatus;
  label: string;
  iconName: string;
  color: string;
}
