import { getConversationIdFromUrl, resolveDevFlowAssociationEvidence, resolveSidebarTitleTarget, type DocumentLike } from './chatgptAdapter.js';

export interface TitleSyncEvaluationInput {
  conversationId: string;
  nativeTitle: string;
  desiredTitle: string;
  nowMs: number;
}

export type TitleSyncAction = 'wait' | 'apply' | 'noop' | 'give-up';

export interface TitleSyncEvaluation {
  action: TitleSyncAction;
}

interface ConversationSyncState {
  lastNativeTitle: string;
  stableSince: number;
  applyCount: number;
}

export function createTitleSyncCoordinator(options: { stabilityMs?: number; maxApplyCount?: number } = {}) {
  const stabilityMs = Math.max(0, options.stabilityMs ?? 1_200);
  const maxApplyCount = Math.max(1, options.maxApplyCount ?? 2);
  const states = new Map<string, ConversationSyncState>();

  return {
    evaluate(input: TitleSyncEvaluationInput): TitleSyncEvaluation {
      const nativeTitle = String(input.nativeTitle || '').trim();
      const desiredTitle = String(input.desiredTitle || '').trim();
      if (!nativeTitle || !desiredTitle) return { action: 'wait' };

      let state = states.get(input.conversationId);
      if (!state) {
        state = { lastNativeTitle: nativeTitle, stableSince: input.nowMs, applyCount: 0 };
        states.set(input.conversationId, state);
      }

      if (nativeTitle === desiredTitle) {
        state.lastNativeTitle = nativeTitle;
        state.stableSince = input.nowMs;
        return { action: 'noop' };
      }

      if (state.lastNativeTitle !== nativeTitle) {
        state.lastNativeTitle = nativeTitle;
        state.stableSince = input.nowMs;
        return { action: 'wait' };
      }

      if (input.nowMs - state.stableSince < stabilityMs) return { action: 'wait' };
      if (state.applyCount >= maxApplyCount) return { action: 'give-up' };

      state.applyCount += 1;
      state.stableSince = input.nowMs;
      return { action: 'apply' };
    },
    reset(conversationId?: string) {
      if (conversationId) states.delete(conversationId);
      else states.clear();
    },
  };
}

type RuntimeReply = { ok?: boolean; title?: string | null } | undefined;

declare const chrome: {
  runtime?: {
    lastError?: { message?: string };
    sendMessage?: (message: unknown, callback: (reply: RuntimeReply) => void) => void;
  };
  storage?: {
    onChanged?: {
      addListener?: (listener: (changes: Record<string, unknown>, areaName: string) => void) => void;
    };
  };
};

const MAX_RESOLUTION_ATTEMPTS = 4;
const RETRY_DELAY_MS = 2_000;
const DEBOUNCE_MS = 250;
const STABILITY_MS = 1_200;

const TITLE_SYNC_SETTING_KEYS = new Set(['enabled', 'pattern', 'devflowBaseUrl']);

export function hasTitleSyncSettingsChange(changes: Record<string, unknown>, areaName: string) {
  return areaName === 'sync' && Object.keys(changes).some(key => TITLE_SYNC_SETTING_KEYS.has(key));
}

export function createTitleResolutionRequest(documentLike: DocumentLike, conversationId: string) {
  const evidence = resolveDevFlowAssociationEvidence(documentLike);
  return {
    type: 'devflow-title-sync:resolve' as const,
    conversationId,
    ...(evidence ? { executionSessionId: evidence.executionSessionId } : {}),
  };
}

function sendRuntimeMessage(message: unknown) {
  return new Promise<RuntimeReply>(resolve => {
    const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
    if (!runtime?.sendMessage) {
      resolve(undefined);
      return;
    }
    runtime.sendMessage(message, reply => {
      if (runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(reply);
    });
  });
}

function startContentScript() {
  if (typeof document === 'undefined' || typeof window === 'undefined' || typeof MutationObserver === 'undefined') return;

  const coordinator = createTitleSyncCoordinator({ stabilityMs: STABILITY_MS, maxApplyCount: 2 });
  const desiredTitles = new Map<string, string>();
  const resolutionAttempts = new Map<string, number>();
  let debounceTimer: number | null = null;
  let retryTimer: number | null = null;
  let activeConversationId: string | null = null;
  let stoppedConversationId: string | null = null;

  const clearRetry = () => {
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    retryTimer = null;
  };

  const schedule = (delayMs = DEBOUNCE_MS) => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    debounceTimer = window.setTimeout(() => {
      debounceTimer = null;
      void reconcile();
    }, delayMs);
  };

  const scheduleRetry = (conversationId: string, delayMs = RETRY_DELAY_MS) => {
    clearRetry();
    retryTimer = window.setTimeout(() => {
      retryTimer = null;
      if (getConversationIdFromUrl(window.location.href) === conversationId) schedule(0);
    }, delayMs);
  };

  const resolveDesiredTitle = async (conversationId: string) => {
    const cached = desiredTitles.get(conversationId);
    if (cached) return cached;

    const attempts = resolutionAttempts.get(conversationId) || 0;
    if (attempts >= MAX_RESOLUTION_ATTEMPTS) return null;
    resolutionAttempts.set(conversationId, attempts + 1);

    const reply = await sendRuntimeMessage(createTitleResolutionRequest(document, conversationId));
    const title = String(reply?.title || '').trim();
    if (!reply?.ok || !title) return null;
    desiredTitles.set(conversationId, title);
    return title;
  };

  const reconcile = async () => {
    const conversationId = getConversationIdFromUrl(window.location.href);
    if (!conversationId) return;

    if (activeConversationId !== conversationId) {
      activeConversationId = conversationId;
      stoppedConversationId = null;
      clearRetry();
    }
    if (stoppedConversationId === conversationId) return;

    const target = resolveSidebarTitleTarget(document, conversationId);
    if (!target) {
      const attempts = resolutionAttempts.get(`dom:${conversationId}`) || 0;
      if (attempts >= MAX_RESOLUTION_ATTEMPTS) {
        stoppedConversationId = conversationId;
        return;
      }
      resolutionAttempts.set(`dom:${conversationId}`, attempts + 1);
      scheduleRetry(conversationId, 1_000);
      return;
    }

    const desiredTitle = await resolveDesiredTitle(conversationId);
    if (!desiredTitle) {
      if ((resolutionAttempts.get(conversationId) || 0) < MAX_RESOLUTION_ATTEMPTS) scheduleRetry(conversationId);
      else stoppedConversationId = conversationId;
      return;
    }

    const nativeTitle = target.readTitle();
    const evaluation = coordinator.evaluate({
      conversationId,
      nativeTitle,
      desiredTitle,
      nowMs: Date.now(),
    });

    if (evaluation.action === 'apply') {
      target.writeTitle(desiredTitle);
      return;
    }
    if (evaluation.action === 'wait') {
      scheduleRetry(conversationId, STABILITY_MS);
      return;
    }
    if (evaluation.action === 'give-up') stoppedConversationId = conversationId;
  };

  const observerRoot = document.querySelector('nav') || document.body;
  if (!observerRoot) return;

  const observer = new MutationObserver(() => schedule());
  observer.observe(observerRoot, { subtree: true, childList: true, characterData: true });
  window.addEventListener('popstate', () => schedule(0));
  window.addEventListener('hashchange', () => schedule(0));

  const storageOnChanged = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
  storageOnChanged?.addListener?.((changes, areaName) => {
    if (!hasTitleSyncSettingsChange(changes, areaName)) return;
    desiredTitles.clear();
    resolutionAttempts.clear();
    stoppedConversationId = null;
    coordinator.reset();
    schedule(0);
  });

  schedule(0);
}

startContentScript();
