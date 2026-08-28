export const DEFAULT_TITLE_PATTERN = '{{taskId}} · {{taskTitle}}';
export const MAX_RENDERED_TITLE_LENGTH = 120;

export interface TitlePatternTokens {
  project?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  chatAlias?: string | null;
}

const TOKEN_PATTERN = /\{\{?\s*([A-Za-z][A-Za-z0-9]*)\s*\}?\}/g;
const SUPPORTED_TOKENS = new Set<keyof TitlePatternTokens>(['project', 'taskId', 'taskTitle', 'chatAlias']);

function cleanRenderedTitle(value: string) {
  return value
    .replace(/\s+/g, ' ')
    .replace(/^[\s·|/—–:\-]+|[\s·|/—–:\-]+$/g, '')
    .replace(/\s+([·|/—–:])\s*([·|/—–:])/g, ' $2 ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_RENDERED_TITLE_LENGTH)
    .trim();
}

function fallbackTitle(tokens: TitlePatternTokens) {
  const taskId = String(tokens.taskId || '').trim();
  const taskTitle = String(tokens.taskTitle || '').trim();
  const chatAlias = String(tokens.chatAlias || '').trim();
  const project = String(tokens.project || '').trim();
  const task = cleanRenderedTitle([taskId, taskTitle].filter(Boolean).join(' · '));
  return task || cleanRenderedTitle(chatAlias) || cleanRenderedTitle(project) || 'DevFlow chat';
}

function render(pattern: string, tokens: TitlePatternTokens) {
  return cleanRenderedTitle(pattern.replace(TOKEN_PATTERN, (_match, rawToken: string) => {
    const token = rawToken as keyof TitlePatternTokens;
    if (!SUPPORTED_TOKENS.has(token)) return '';
    return String(tokens[token] || '').trim();
  }));
}

export function renderTitlePattern(pattern: string | null | undefined, tokens: TitlePatternTokens) {
  const requested = String(pattern || '').trim() || DEFAULT_TITLE_PATTERN;
  const rendered = render(requested, tokens);
  if (!rendered || /[{}]/.test(rendered)) return fallbackTitle(tokens);
  return rendered;
}
