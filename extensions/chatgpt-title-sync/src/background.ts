import {
  associateDevFlowConversation,
  DEFAULT_DEVFLOW_BASE_URL,
  listDevFlowPairingCandidates,
  resolveDevFlowTitleMetadata,
} from './devflowClient.js';
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

function renderMetadataTitle(settings: ExtensionSettings, metadata: Awaited<ReturnType<typeof resolveDevFlowTitleMetadata>>) {
  if (!metadata) return null;
  const preferred = String(metadata.preferredTitle || '').trim();
  return preferred || renderTitlePattern(settings.pattern, {
    project: metadata.project,
    taskId: metadata.taskId,
    taskTitle: metadata.taskTitle,
    chatAlias: metadata.chatAlias,
  });
}

export async function resolveRequestedTitle(conversationId: string, executionSessionId?: string | null) {
  const settings = await readSettings();
  if (!settings.enabled) return null;

  let metadata = await resolveDevFlowTitleMetadata(settings.devflowBaseUrl, conversationId);
  const normalizedExecutionSessionId = String(executionSessionId || '').trim();
  if (normalizedExecutionSessionId && metadata?.executionSessionId !== normalizedExecutionSessionId) {
    const associated = await associateDevFlowConversation(
      settings.devflowBaseUrl,
      conversationId,
      normalizedExecutionSessionId,
      undefined,
      metadata?.executionSessionId,
    );
    if (!associated) return null;
    metadata = await resolveDevFlowTitleMetadata(settings.devflowBaseUrl, conversationId);
  }
  return renderMetadataTitle(settings, metadata);
}

async function listRequestedPairingCandidates(conversationId: string) {
  const settings = await readSettings();
  if (!settings.enabled) return [];
  return listDevFlowPairingCandidates(settings.devflowBaseUrl, undefined, conversationId);
}

async function pairRequestedConversation(conversationId: string, executionSessionId: string) {
  const settings = await readSettings();
  if (!settings.enabled) return null;
  const current = await resolveDevFlowTitleMetadata(settings.devflowBaseUrl, conversationId);
  const associated = await associateDevFlowConversation(
    settings.devflowBaseUrl,
    conversationId,
    executionSessionId,
    undefined,
    current?.executionSessionId,
    'chatgpt-explicit-pairing',
  );
  if (!associated) return null;
  const metadata = await resolveDevFlowTitleMetadata(settings.devflowBaseUrl, conversationId);
  return renderMetadataTitle(settings, metadata);
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const conversationId = String(message?.conversationId || '').trim();
    if (message?.type === 'devflow-title-sync:resolve') {
      const executionSessionId = String(message?.executionSessionId || '').trim() || null;
      void resolveRequestedTitle(conversationId, executionSessionId)
        .then(title => sendResponse({ ok: Boolean(title), title }))
        .catch(() => sendResponse({ ok: false, title: null }));
      return true;
    }
    if (message?.type === 'devflow-title-sync:candidates') {
      void listRequestedPairingCandidates(conversationId)
        .then(candidates => sendResponse({ ok: true, candidates }))
        .catch(() => sendResponse({ ok: false, candidates: [] }));
      return true;
    }
    if (message?.type === 'devflow-title-sync:pair') {
      const executionSessionId = String(message?.executionSessionId || '').trim();
      void pairRequestedConversation(conversationId, executionSessionId)
        .then(title => sendResponse({ ok: Boolean(title), title }))
        .catch(() => sendResponse({ ok: false, title: null }));
      return true;
    }
    return undefined;
  });
}
