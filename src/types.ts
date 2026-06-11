/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'ready-for-review' | 'done';
export type TaskPriority = 'high' | 'medium' | 'low';

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

export interface Task {
  id: string;
  displayId?: string; // e.g. buddy2-0001
  projectId?: string; // Links to a specific Project
  title: string;
  description: string;
  status: TaskStatus;
  branch?: string;
  priority: TaskPriority;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  logs: LogEntry[];
  targetFiles?: string[];
  checklist?: ChecklistItem[];
  designImage?: string; // DEPRECATED: use designImages
  designImages?: string[]; // Array of up to 5 Image URLs/Base64s
  specUrl?: string; // Specification link or text
  agent?: string; // Codex | Antigravity | Claude
  activeAgent?: string; // Currently working agent
  model?: string; // Model name
  parentId?: string; // ID of the parent task if this is a subtask
  effort?: string; // Effort level (low | medium | high | xhigh)
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
