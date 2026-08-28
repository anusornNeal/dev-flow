export const DEFAULT_DEVFLOW_BASE_URL = 'http://127.0.0.1:3000';

export interface DevFlowTitleMetadata {
  executionSessionId: string;
  conversationId: string;
  project: string;
  taskId: string;
  taskTitle: string;
  chatAlias: string | null;
  preferredTitle: string | null;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost']);
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{3,200}$/;
const EXECUTION_SESSION_ID_PATTERN = /^exec-[A-Za-z0-9_-]{3,195}$/;
const REQUEST_TIMEOUT_MS = 1_800;

export function normalizeDevFlowBaseUrl(value: string | null | undefined) {
  try {
    const url = new URL(String(value || '').trim() || DEFAULT_DEVFLOW_BASE_URL);
    if (url.protocol !== 'http:') return null;
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export async function associateDevFlowConversation(
  baseUrlValue: string,
  conversationId: string,
  executionSessionId: string,
  request: FetchLike = (input, init) => fetch(input, init),
  previousExecutionSessionId?: string,
): Promise<boolean> {
  const baseUrl = normalizeDevFlowBaseUrl(baseUrlValue);
  if (!baseUrl || !CONVERSATION_ID_PATTERN.test(conversationId) || !EXECUTION_SESSION_ID_PATTERN.test(executionSessionId)) return false;
  if (previousExecutionSessionId && !EXECUTION_SESSION_ID_PATTERN.test(previousExecutionSessionId)) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await request(`${baseUrl}/api/chat-sessions/title-associations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
      body: JSON.stringify({
        executionSessionId,
        conversationId,
        ...(previousExecutionSessionId ? { previousExecutionSessionId } : {}),
        source: 'chatgpt-structured-tool-metadata',
      }),
    });
    if (!response.ok) return false;
    const data = await response.json() as { bound?: boolean; executionSessionId?: string; conversationId?: string };
    return data.bound === true && data.executionSessionId === executionSessionId && data.conversationId === conversationId;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

export async function resolveDevFlowTitleMetadata(
  baseUrlValue: string,
  conversationId: string,
  request: FetchLike = (input, init) => fetch(input, init),
): Promise<DevFlowTitleMetadata | null> {
  const baseUrl = normalizeDevFlowBaseUrl(baseUrlValue);
  if (!baseUrl || !CONVERSATION_ID_PATTERN.test(conversationId)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await request(`${baseUrl}/api/chat-sessions/title?conversationId=${encodeURIComponent(conversationId)}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json() as Partial<DevFlowTitleMetadata> & { resolved?: boolean };
    if (data.resolved !== true) return null;
    if (!data.executionSessionId || !data.conversationId || !data.taskId || !data.taskTitle) return null;
    return {
      executionSessionId: String(data.executionSessionId),
      conversationId: String(data.conversationId),
      project: String(data.project || ''),
      taskId: String(data.taskId),
      taskTitle: String(data.taskTitle),
      chatAlias: data.chatAlias == null ? null : String(data.chatAlias),
      preferredTitle: data.preferredTitle == null ? null : String(data.preferredTitle),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
