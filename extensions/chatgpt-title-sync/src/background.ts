import { DEFAULT_DEVFLOW_BASE_URL, resolveDevFlowTitleMetadata } from './devflowClient.js';
import { DEFAULT_TITLE_PATTERN, renderTitlePattern } from './titlePattern.js';

export interface ExtensionSettings {
  enabled: boolean;
  pattern: string;
  devflowBaseUrl: string;
}

const DEFAULT_SETTINGS: ExtensionSettings = {
  enabled: true,
  pattern: DEFAULT_TITLE_PATTERN,
  devflowBaseUrl: DEFAULT_DEVFLOW_BASE_URL,
};

type StorageValues = Partial<Record<keyof ExtensionSettings, unknown>>;

declare const chrome: {
  storage: {
    sync: {
      get: (keys: string[], callback: (values: StorageValues) => void) => void;
    };
  };
  runtime: {
    lastError?: { message?: string };
    onMessage: {
      addListener: (listener: (message: any, sender: unknown, sendResponse: (reply: unknown) => void) => boolean | void) => void;
    };
  };
};

function readSettings() {
  return new Promise<ExtensionSettings>(resolve => {
    chrome.storage.sync.get(['enabled', 'pattern', 'devflowBaseUrl'], values => {
      if (chrome.runtime.lastError) {
        resolve(DEFAULT_SETTINGS);
        return;
      }
      resolve({
        enabled: values.enabled !== false,
        pattern: typeof values.pattern === 'string' && values.pattern.trim() ? values.pattern : DEFAULT_SETTINGS.pattern,
        devflowBaseUrl: typeof values.devflowBaseUrl === 'string' && values.devflowBaseUrl.trim() ? values.devflowBaseUrl : DEFAULT_SETTINGS.devflowBaseUrl,
      });
    });
  });
}

export async function resolveRequestedTitle(conversationId: string) {
  const settings = await readSettings();
  if (!settings.enabled) return null;
  const metadata = await resolveDevFlowTitleMetadata(settings.devflowBaseUrl, conversationId);
  if (!metadata) return null;
  const preferred = String(metadata.preferredTitle || '').trim();
  return preferred || renderTitlePattern(settings.pattern, {
    project: metadata.project,
    taskId: metadata.taskId,
    taskTitle: metadata.taskTitle,
    chatAlias: metadata.chatAlias,
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'devflow-title-sync:resolve') return undefined;
    const conversationId = String(message?.conversationId || '').trim();
    void resolveRequestedTitle(conversationId)
      .then(title => sendResponse({ ok: Boolean(title), title }))
      .catch(() => sendResponse({ ok: false, title: null }));
    return true;
  });
}
