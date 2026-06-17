/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'ready-for-review' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';
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
  repoContext?: string;
  jiraKey?: string;
  repo?: string;
  sourceUrl?: string;
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
