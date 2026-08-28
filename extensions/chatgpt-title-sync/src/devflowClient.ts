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

export function normalizeDevFlowBaseUrl(value: string | null | undefined) {
  try {
    const url = new URL(String(value || '').trim() || 'http://127.0.0.1:3000');
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

export async function resolveDevFlowTitleMetadata(
  baseUrlValue: string,
  conversationId: string,
  request: FetchLike = (input, init) => fetch(input, init),
): Promise<DevFlowTitleMetadata | null> {
  const baseUrl = normalizeDevFlowBaseUrl(baseUrlValue);
  if (!baseUrl || !/^[A-Za-z0-9_-]{3,200}$/.test(conversationId)) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1_800);
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
