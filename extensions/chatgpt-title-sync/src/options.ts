import { DEFAULT_DEVFLOW_BASE_URL, normalizeDevFlowBaseUrl } from './devflowClient.js';
import { DEFAULT_TITLE_PATTERN } from './titlePattern.js';

declare const chrome: {
  storage: {
    sync: {
      get: (keys: string[], callback: (values: Record<string, unknown>) => void) => void;
      set: (values: Record<string, unknown>, callback?: () => void) => void;
    };
  };
  runtime: { lastError?: { message?: string } };
};

function input<T extends HTMLElement>(id: string) {
  return document.getElementById(id) as T | null;
}

function setStatus(message: string, tone: 'normal' | 'error' | 'success' = 'normal') {
  const status = input<HTMLElement>('status');
  if (!status) return;
  status.textContent = message;
  status.dataset.tone = tone;
}

function loadOptions() {
  chrome.storage.sync.get(['enabled', 'pattern', 'devflowBaseUrl'], values => {
    const enabled = input<HTMLInputElement>('enabled');
    const pattern = input<HTMLInputElement>('pattern');
    const baseUrl = input<HTMLInputElement>('devflowBaseUrl');
    if (enabled) enabled.checked = values.enabled !== false;
    if (pattern) pattern.value = typeof values.pattern === 'string' && values.pattern.trim() ? values.pattern : DEFAULT_TITLE_PATTERN;
    if (baseUrl) baseUrl.value = typeof values.devflowBaseUrl === 'string' && values.devflowBaseUrl.trim() ? values.devflowBaseUrl : DEFAULT_DEVFLOW_BASE_URL;
  });
}

function saveOptions(event: Event) {
  event.preventDefault();
  const enabled = input<HTMLInputElement>('enabled')?.checked !== false;
  const pattern = input<HTMLInputElement>('pattern')?.value.trim() || DEFAULT_TITLE_PATTERN;
  const requestedBaseUrl = input<HTMLInputElement>('devflowBaseUrl')?.value || DEFAULT_DEVFLOW_BASE_URL;
  const devflowBaseUrl = normalizeDevFlowBaseUrl(requestedBaseUrl);
  if (!devflowBaseUrl) {
    setStatus('DevFlow URL must use http:// on localhost or 127.0.0.1.', 'error');
    return;
  }

  chrome.storage.sync.set({ enabled, pattern, devflowBaseUrl }, () => {
    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message || 'Could not save settings.', 'error');
      return;
    }
    setStatus('Saved. Open conversations will update on the next supported sidebar change.', 'success');
  });
}

function resetOptions() {
  const enabled = input<HTMLInputElement>('enabled');
  const pattern = input<HTMLInputElement>('pattern');
  const baseUrl = input<HTMLInputElement>('devflowBaseUrl');
  if (enabled) enabled.checked = true;
  if (pattern) pattern.value = DEFAULT_TITLE_PATTERN;
  if (baseUrl) baseUrl.value = DEFAULT_DEVFLOW_BASE_URL;
  setStatus('Defaults restored locally. Press Save to apply.', 'normal');
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    loadOptions();
    input<HTMLFormElement>('settingsForm')?.addEventListener('submit', saveOptions);
    input<HTMLButtonElement>('reset')?.addEventListener('click', resetOptions);
  });
}
