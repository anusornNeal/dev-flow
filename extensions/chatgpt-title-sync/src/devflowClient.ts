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

export interface DevFlowPairingCandidate {
  executionSessionId: string;
  project: string;
  taskId: string;
  taskTitle: string;
  available?: boolean;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export type DevFlowAssociationSource = 'chatgpt-structured-tool-metadata' | 'chatgpt-explicit-pairing';

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
  source: DevFlowAssociationSource = 'chatgpt-structured-tool-metadata',
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
        source,
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

export async function listDevFlowPairingCandidates(
  baseUrlValue: string,
  request: FetchLike = (input, init) => fetch(input, init),
  conversationId?: string,
): Promise<DevFlowPairingCandidate[]> {
  const baseUrl = normalizeDevFlowBaseUrl(baseUrlValue);
  if (!baseUrl || (conversationId && !CONVERSATION_ID_PATTERN.test(conversationId))) return [];
  const suffix = conversationId ? `?conversationId=${encodeURIComponent(conversationId)}` : '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await request(`${baseUrl}/api/chat-sessions/title-candidates${suffix}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return [];
    const data = await response.json() as { candidates?: unknown };
    if (!Array.isArray(data.candidates)) return [];
    return data.candidates.flatMap((value: any) => {
      const executionSessionId = String(value?.executionSessionId || '').trim();
      const taskId = String(value?.taskId || '').trim();
      const taskTitle = String(value?.taskTitle || '').trim();
      if (!EXECUTION_SESSION_ID_PATTERN.test(executionSessionId) || !taskId || !taskTitle) return [];
      return [{
        executionSessionId,
        project: String(value?.project || '').slice(0, 120),
        taskId: taskId.slice(0, 80),
        taskTitle: taskTitle.slice(0, 200),
        ...(typeof value?.available === 'boolean' ? { available: value.available } : {}),
      }];
    });
  } catch {
    return [];
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
