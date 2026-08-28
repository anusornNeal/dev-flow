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
export type VerificationEvidenceStatus = 'passed' | 'failed' | 'not-run';

export interface VerificationEvidenceCheck {
  name: string;
  command: string;
  status: VerificationEvidenceStatus;
  scope?: 'targeted' | 'broad' | 'full';
  repoRevision?: string;
  summary?: string;
  output?: string;
  recordedAt?: string;
}

export interface TaskGitEvidence {
  evidenceSource?: 'project-root' | 'managed-workspace';
  workspaceId?: string;
  branch: string; // Actual branch observed where the Git evidence was collected.
  targetBranch?: string | null; // Logical task/integration target for managed workspace evidence.
  workspaceBranch?: string | null; // Recorded physical DevFlow workspace branch for managed evidence.
  commit: string;
  remote: string;
  trackingBranch?: string | null;
  remoteHead?: string | null;
  ahead: number | null;
  behind: number | null;
  diverged: boolean;
  pushed: boolean;
  workingTreeClean: boolean;
  remoteFetchPerformed?: boolean;
  remoteEvidenceReused?: boolean;
  remoteFetchDurationMs?: number;
  remoteEvidenceObservedAt?: string;
  remoteEvidenceAgeMs?: number;
  recordedAt: string;
}

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

export interface TaskClaim {
  sessionIdHash: string;
  ownershipEpochId?: string; // Required on newly issued claims; optional only for persisted legacy claims.
  workspaceId: string;
  ownerKind: 'chat' | 'codex' | 'claude' | 'antigravity' | 'agent';
  ownerLabel: string;
  claimedAt: string;
  expiresAt: string;
  reservedPaths?: string[]; // Canonical runtime scope reserved beyond initial targetFiles.
}

export type TaskLiveWorkPhase = 'inspecting' | 'editing' | 'verifying' | 'committing' | 'integrating' | 'finalizing' | 'blocked' | 'working';

export interface TaskLiveWorkProjection {
  source: 'managed' | 'agent';
  ownerLabel: string;
  ownerKind?: TaskClaim['ownerKind'] | 'agent';
  phase: TaskLiveWorkPhase;
  phaseLabel: string;
  activity?: string | null;
  phaseIndex: number;
  phaseCount: number;
  blocked?: boolean;
  startedAt?: string | null;
  updatedAt?: string | null;
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
  archivedAt?: string | null;
  claim?: TaskClaim;
  liveWork?: TaskLiveWorkProjection | null;
  logs: LogEntry[];
  targetFiles?: string[];
  checklist?: ChecklistItem[];
  bugs?: BugThread[];
  unresolvedBugCount?: number;
  latestUnresolvedBug?: Pick<BugThread, 'id' | 'title' | 'status' | 'severity' | 'updatedAt'> | null;
  hasUiDesign?: boolean;
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
  prerequisiteTaskIds?: string[]; // Canonical same-project prerequisite task IDs; independent siblings omit this field.
  effort?: string; // Effort level (varies by agent and model)
  reasoning?: string;
  acceptanceCriteria?: string;
  verification?: string;
  gitEvidence?: TaskGitEvidence;
  verificationEvidence?: VerificationEvidenceCheck[];
  repo?: string;
}

export type GitIntegrationStrategy = 'rebase-ff' | 'merge';

export interface GitWorkflowPolicy {
  integrationStrategy?: GitIntegrationStrategy;
  commitMessageTemplate?: string;
  mergeMessageTemplate?: string;
}

export interface ResolvedGitWorkflowPolicy {
  integrationStrategy: GitIntegrationStrategy;
  commitMessageTemplate: string;
  mergeMessageTemplate: string;
}

export interface Project {
  id: string;
  name: string;
  repoUrl: string;
  description?: string;
  localPath?: string; // Absolute path to the local project directory
  taskIdPrefix?: string; // Custom prefix for task display IDs (e.g. DVF)
  gitWorkflowPolicy?: GitWorkflowPolicy;
  createdAt: string;
}

export type AtlasFactSource = 'verified' | 'inferred' | 'user-edited';
export type AtlasScanMode = 'automatic' | 'manual' | 'task-focused';
export type AtlasFreshnessStatus = 'not-generated' | 'fresh' | 'stale' | 'error';
export type AtlasNodeKind =
  | 'project'
  | 'folder'
  | 'file'
  | 'symbol'
  | 'route'
  | 'component'
  | 'test'
  | 'database'
  | 'script'
  | 'config'
  | 'domain';
export type AtlasEdgeKind =
  | 'contains'
  | 'imports'
  | 'exports'
  | 'calls'
  | 'tests'
  | 'routes'
  | 'reads'
  | 'writes'
  | 'depends-on'
  | 'related';

export interface AtlasVerifiedFact {
  source: 'verified';
  description: string;
  evidence?: string;
}

export interface AtlasInferredFact {
  source: 'inferred';
  summary: string;
  confidence?: number;
}

export interface AtlasUserEditedFact {
  source: 'user-edited';
  notes: string;
  updatedAt?: string;
}

export type AtlasFact = AtlasVerifiedFact | AtlasInferredFact | AtlasUserEditedFact;

export interface AtlasNode {
  id: string;
  label: string;
  kind: AtlasNodeKind;
  path?: string;
  verified?: AtlasVerifiedFact;
  inferred?: AtlasInferredFact;
  userEdited?: AtlasUserEditedFact;
  metadata?: Record<string, unknown>;
}

export interface AtlasEdge {
  id: string;
  source: string;
  target: string;
  kind: AtlasEdgeKind;
  fact: AtlasFact;
  metadata?: Record<string, unknown>;
}

export interface AtlasDomain {
  id: string;
  name: string;
  nodeIds: string[];
  origin: AtlasFactSource;
  summary?: string;
  metadata?: Record<string, unknown>;
}

export interface AtlasFlow {
  id: string;
  name: string;
  nodeIds: string[];
  origin: AtlasFactSource;
  summary?: string;
}

export interface AtlasSummary {
  verified?: AtlasVerifiedFact;
  inferred?: AtlasInferredFact;
  userEdited?: AtlasUserEditedFact;
}

export interface AtlasFreshness {
  generatedAt?: string;
  lastDailyOpenCheckedAt?: string;
  scanMode?: AtlasScanMode;
  repoFingerprint?: string;
  status: AtlasFreshnessStatus;
  staleReason?: string;
  lastError?: string;
}

export type AtlasAgentOverlaySeverity = 'info' | 'warning' | 'error';
export type AtlasAuthoringSeverity = AtlasAgentOverlaySeverity;

export interface AtlasEvidencePath {
  path: string;
  nodeId?: string;
  excerpt?: string;
  startLine?: number;
  endLine?: number;
}

export type AtlasAgentEvidence = AtlasEvidencePath & { nodeId: string };

export interface AtlasAgentUpdateProvenance {
  provider: string;
  model?: string;
  prompt?: string;
  runId?: string;
}

export interface AtlasRepoCoverageSkippedArea {
  path: string;
  reason: string;
}

export interface AtlasRepoCoverageNotes {
  notes: string[];
  skippedAreas: AtlasRepoCoverageSkippedArea[];
}

export interface AtlasDomainGroupingRationale {
  domainId: string;
  rationale: string;
  evidence?: AtlasEvidencePath[];
}

export interface AtlasGroupingRationale {
  summary: string;
  domainRationales?: AtlasDomainGroupingRationale[];
}

export interface AtlasAuthoredReadOrderItem {
  nodeId: string;
  path?: string;
  reason: string;
  evidence?: AtlasEvidencePath[];
}

export interface AtlasAuthoredWarning {
  message: string;
  severity: AtlasAuthoringSeverity;
  evidence?: AtlasEvidencePath[];
}

export interface ProjectAtlasAgentUpdatePatch {
  projectId: string;
  provenance: AtlasAgentUpdateProvenance;
  generatedAt?: string;
  repoFingerprint?: string;
  coverage: AtlasRepoCoverageNotes;
  groupingRationale: AtlasGroupingRationale;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  domains: AtlasDomain[];
  flows?: AtlasFlow[];
  summary?: AtlasSummary;
  readOrder?: AtlasAuthoredReadOrderItem[];
  warnings?: AtlasAuthoredWarning[];
  evidence?: AtlasEvidencePath[];
}

export interface AtlasAgentOverlayDiagnostic {
  code: string;
  message: string;
  severity: AtlasAgentOverlaySeverity;
  path?: string;
  nodeId?: string;
}

export interface ProjectAtlasAuthoringMetadata {
  updatedAt: string;
  provenance: AtlasAgentUpdateProvenance;
  coverage: AtlasRepoCoverageNotes;
  groupingRationale: AtlasGroupingRationale;
  evidence: AtlasEvidencePath[];
  readOrder: AtlasAuthoredReadOrderItem[];
  warnings: AtlasAuthoredWarning[];
}

export interface ProjectAtlas {
  schemaVersion: 1;
  projectId: string;
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  domains: AtlasDomain[];
  flows: AtlasFlow[];
  summary: AtlasSummary;
  freshness: AtlasFreshness;
  authoring?: ProjectAtlasAuthoringMetadata;
}

export interface AtlasScanStats {
  scannedFileCount: number;
  skippedDirectories: string[];
  skippedDirectoryCount: number;
  durationMs: number;
  truncated: boolean;
  warnings: string[];
  errors: string[];
}

export interface ProjectAtlasScanResult {
  atlas: ProjectAtlas;
  scanStats: AtlasScanStats;
}

export interface AtlasDomainOverride {
  id: string;
  name: string;
  nodeIds: string[];
}

export interface AtlasDomainOverrideMap {
  projectId: string;
  domains: AtlasDomainOverride[];
  updatedAt?: string;
}

export interface AtlasDomainSummary {
  id: string;
  name: string;
  origin: AtlasFactSource;
  nodeCount: number;
  fileCount: number;
}

export interface AtlasDomainGraphSummary {
  domains: AtlasDomainSummary[];
  relatedEdges: AtlasEdge[];
}

export interface ProjectAtlasUiResponse {
  atlas: ProjectAtlas;
  domainSummary: AtlasDomainGraphSummary;
  status: 'empty' | 'ready' | 'error';
  stale: boolean;
  refreshStatus?: {
    shouldRefresh?: boolean;
    reason?: string;
    freshness?: AtlasFreshness;
  };
  message?: string;
}

export type ChatSessionTitleResolution =
  | {
      resolved: true;
      executionSessionId: string;
      conversationId: string;
      project: string;
      taskId: string;
      taskTitle: string;
      chatAlias: string | null;
      preferredTitle: string | null;
    }
  | {
      resolved: false;
      reason: 'invalid-conversation-id' | 'unresolved-session' | 'ambiguous-session';
    };

export interface Column {
  id: TaskStatus;
  label: string;
  iconName: string;
  color: string;
}
