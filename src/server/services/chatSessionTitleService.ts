import {
  getExecutionSessionById,
  queryLatestExecutionSessionEvidence,
  saveExecutionSessionEvidence,
  setExecutionSessionEvidenceStale,
} from '../repositories/executionSessionRepository.js';
import { getTask } from '../repositories/taskRepository.js';
import { getProject } from '../repositories/projectRepository.js';
import type { ChatSessionTitleResolution } from '../../types.js';

export const CHAT_SESSION_TITLE_EVIDENCE_KIND = 'chat-title-preference';
const MAX_CONVERSATION_ID_LENGTH = 200;
const MAX_ALIAS_LENGTH = 120;
const MAX_PREFERRED_TITLE_LENGTH = 160;

export class ChatSessionTitleServiceError extends Error {
  constructor(
    public code: 'INVALID_CHAT_TITLE_BINDING' | 'EXECUTION_SESSION_NOT_FOUND' | 'TASK_NOT_FOUND' | 'PROJECT_NOT_FOUND',
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

function boundedOptionalText(value: unknown, maxLength: number) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

export function normalizeChatConversationId(value: unknown) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > MAX_CONVERSATION_ID_LENGTH) return null;
  return /^[A-Za-z0-9_-]{3,200}$/.test(normalized) ? normalized : null;
}

export function bindChatSessionTitlePreference(input: {
  executionSessionId: unknown;
  conversationId: unknown;
  chatAlias?: unknown;
  preferredTitle?: unknown;
  now?: Date;
}) {
  const executionSessionId = String(input.executionSessionId || '').trim();
  const conversationId = normalizeChatConversationId(input.conversationId);
  if (!executionSessionId || !conversationId) {
    throw new ChatSessionTitleServiceError('INVALID_CHAT_TITLE_BINDING', 'executionSessionId and a valid conversationId are required.', 400);
  }

  const session = getExecutionSessionById(executionSessionId);
  if (!session) throw new ChatSessionTitleServiceError('EXECUTION_SESSION_NOT_FOUND', `Execution session '${executionSessionId}' was not found.`, 404);
  if (!session.taskId) throw new ChatSessionTitleServiceError('TASK_NOT_FOUND', `Execution session '${executionSessionId}' is not attached to a task.`, 404);
  const task = getTask(session.taskId);
  if (!task) throw new ChatSessionTitleServiceError('TASK_NOT_FOUND', `Task '${session.taskId}' was not found.`, 404);
  const project = getProject(session.projectId);
  if (!project) throw new ChatSessionTitleServiceError('PROJECT_NOT_FOUND', `Project '${session.projectId}' was not found.`, 404);

  const nowIso = (input.now || new Date()).toISOString();
  const existing = queryLatestExecutionSessionEvidence(CHAT_SESSION_TITLE_EVIDENCE_KIND, 100).evidence;
  for (const evidence of existing) {
    if (evidence.sessionId === session.id || evidence.stale) continue;
    if (String(evidence.metadata?.conversationId || '') === conversationId) {
      setExecutionSessionEvidenceStale(evidence.id, true, nowIso);
    }
  }

  const evidence = saveExecutionSessionEvidence({
    id: `${CHAT_SESSION_TITLE_EVIDENCE_KIND}:${session.id}`,
    sessionId: session.id,
    kind: CHAT_SESSION_TITLE_EVIDENCE_KIND,
    path: null,
    repoRevision: session.repoRevision,
    fileRevision: null,
    revisionIdentity: null,
    contextHandle: session.contextHandle,
    stale: false,
    metadata: {
      schema: 'chat-title-preference.v1',
      conversationId,
      chatAlias: boundedOptionalText(input.chatAlias, MAX_ALIAS_LENGTH),
      preferredTitle: boundedOptionalText(input.preferredTitle, MAX_PREFERRED_TITLE_LENGTH),
      displayOnly: true,
    },
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return {
    bound: true as const,
    executionSessionId: session.id,
    conversationId,
    evidenceId: evidence.id,
  };
}

export function resolveChatSessionTitle(conversationIdValue: unknown): ChatSessionTitleResolution {
  const conversationId = normalizeChatConversationId(conversationIdValue);
  if (!conversationId) return { resolved: false, reason: 'invalid-conversation-id' };

  const matches = queryLatestExecutionSessionEvidence(CHAT_SESSION_TITLE_EVIDENCE_KIND, 100).evidence
    .filter(evidence => !evidence.stale && String(evidence.metadata?.conversationId || '') === conversationId);
  if (matches.length !== 1) return { resolved: false, reason: matches.length > 1 ? 'ambiguous-session' : 'unresolved-session' };

  const evidence = matches[0];
  const session = getExecutionSessionById(evidence.sessionId);
  if (!session?.taskId) return { resolved: false, reason: 'unresolved-session' };
  const task = getTask(session.taskId);
  const project = getProject(session.projectId);
  if (!task || !project) return { resolved: false, reason: 'unresolved-session' };

  return {
    resolved: true,
    executionSessionId: session.id,
    conversationId,
    project: String(project.name || project.id),
    taskId: String(task.displayId || task.id),
    taskTitle: String(task.title || ''),
    chatAlias: boundedOptionalText(evidence.metadata?.chatAlias, MAX_ALIAS_LENGTH),
    preferredTitle: boundedOptionalText(evidence.metadata?.preferredTitle, MAX_PREFERRED_TITLE_LENGTH),
  };
}
