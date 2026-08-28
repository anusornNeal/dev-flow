export interface QueryNodeLike {
  textContent?: string | null;
  querySelector?: (selector: string) => QueryNodeLike | null;
  getAttribute?: (name: string) => string | null;
  setAttribute?: (name: string, value: string) => void;
}

export interface DocumentLike {
  querySelector: (selector: string) => QueryNodeLike | null;
}

export interface SidebarTitleTarget {
  readTitle: () => string;
  writeTitle: (title: string) => void;
  isDevFlowTitle: (title: string) => boolean;
}

const SUPPORTED_HOSTS = new Set(['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com']);
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]{3,200}$/;
const TITLE_SELECTORS = [
  '[data-testid="conversation-title"]',
  '[data-testid*="conversation-title"]',
  '[dir="auto"]',
  'div[title]',
];

function normalizeTitle(value: unknown) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function getConversationIdFromUrl(urlValue: string) {
  try {
    const url = new URL(urlValue);
    if (!SUPPORTED_HOSTS.has(url.hostname.toLowerCase())) return null;
    const match = url.pathname.match(/^\/c\/([^/?#]+)(?:\/|$)/);
    const conversationId = match?.[1] || '';
    return CONVERSATION_ID_PATTERN.test(conversationId) ? conversationId : null;
  } catch {
    return null;
  }
}

function safeConversationSelector(conversationId: string) {
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) return null;
  return `a[href="/c/${conversationId}"], a[href^="/c/${conversationId}?"]`;
}

export function resolveSidebarTitleTarget(documentLike: DocumentLike, conversationId: string): SidebarTitleTarget | null {
  const anchorSelector = safeConversationSelector(conversationId);
  if (!anchorSelector) return null;
  const anchor = documentLike.querySelector(anchorSelector);
  if (!anchor?.querySelector) return null;

  let titleNode: QueryNodeLike | null = null;
  for (const selector of TITLE_SELECTORS) {
    titleNode = anchor.querySelector(selector);
    if (titleNode && typeof titleNode.textContent === 'string') break;
  }
  if (!titleNode || typeof titleNode.textContent !== 'string') return null;

  return {
    readTitle: () => normalizeTitle(titleNode?.textContent),
    writeTitle: (title: string) => {
      const normalized = normalizeTitle(title);
      if (!normalized || !titleNode) return;
      titleNode.textContent = normalized;
      titleNode.setAttribute?.('title', normalized);
      anchor.setAttribute?.('data-devflow-title-sync', normalized);
    },
    isDevFlowTitle: (title: string) => anchor.getAttribute?.('data-devflow-title-sync') === normalizeTitle(title),
  };
}
