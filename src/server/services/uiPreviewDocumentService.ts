export interface UiPreviewDocumentInput {
  title?: string | null;
  html: string;
  css?: string | null;
  js?: string | null;
}

export interface UiPreviewDocument {
  html: string;
  csp: string;
}

export interface UiPreviewWorkspaceScreenInput extends UiPreviewDocumentInput {
  screenId: string;
  name: string;
  href: string;
}

export interface UiPreviewWorkspaceDocumentInput {
  title?: string | null;
  selectedScreenId: string;
  screens: UiPreviewWorkspaceScreenInput[];
}

export const UI_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'sandbox allow-scripts',
].join('; ');

export const UI_PREVIEW_WORKSPACE_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'self' data: blob:",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "worker-src 'none'",
  "img-src 'none'",
  "font-src 'none'",
  "media-src 'none'",
  "style-src 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'sandbox allow-scripts',
].join('; ');

export const UI_PREVIEW_CAPABILITY_GUARD_SCRIPT = `(() => {
  const blocked = () => { throw new Error('UI preview sandbox blocked this capability.'); };
  const blockedConstructor = function () { blocked(); };
  for (const key of [
    'fetch',
    'XMLHttpRequest',
    'WebSocket',
    'EventSource',
    'Worker',
    'SharedWorker',
    'WebTransport',
    'RTCPeerConnection',
    'webkitRTCPeerConnection'
  ]) {
    try { Object.defineProperty(globalThis, key, { value: blockedConstructor, configurable: false, writable: false }); } catch {}
  }
  try { Object.defineProperty(window, 'open', { value: () => null, configurable: false, writable: false }); } catch {}
  try { Object.defineProperty(navigator, 'sendBeacon', { value: () => false, configurable: false, writable: false }); } catch {}
  try { Object.defineProperty(navigator, 'serviceWorker', { get: blocked, configurable: false }); } catch {}
  for (const key of ['localStorage', 'sessionStorage']) {
    try { Object.defineProperty(globalThis, key, { get: blocked, configurable: false }); } catch {}
  }
})();`;

function escapeHtmlText(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeHtmlAttribute(value: string) {
  return escapeHtmlText(value);
}

function escapeRawTextClosingTag(value: string, tagName: 'style' | 'script') {
  return value.replace(new RegExp(`<\\/${tagName}`, 'gi'), `<\\/${tagName}`);
}

/**
 * Compose the only outer HTML document used by UI Preview. Caller source is
 * always treated as a body fragment plus raw CSS/JS payloads; DevFlow owns the
 * document, CSP contract and capability guard.
 */
export function composeUiPreviewDocument(input: UiPreviewDocumentInput): UiPreviewDocument {
  const title = escapeHtmlText(input.title ?? 'DevFlow UI Preview');
  const css = escapeRawTextClosingTag(input.css ?? '', 'style');
  const guard = escapeRawTextClosingTag(UI_PREVIEW_CAPABILITY_GUARD_SCRIPT, 'script');
  const js = escapeRawTextClosingTag(input.js ?? '', 'script');

  return {
    csp: UI_PREVIEW_CSP,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${UI_PREVIEW_CSP}">
<title>${title}</title>
<style>${css}</style>
</head>
<body>
${input.html}
<script>${guard}</script>
<script>${js}</script>
</body>
</html>`,
  };
}

/**
 * Compose server-owned workspace chrome around exactly one selected screen.
 * Screen source is isolated in a sandboxed srcdoc iframe so caller HTML/JS
 * cannot mutate the navigator or escape into DevFlow UI.
 */
export function composeUiPreviewWorkspaceDocument(input: UiPreviewWorkspaceDocumentInput): UiPreviewDocument {
  const selected = input.screens.find((screen) => screen.screenId === input.selectedScreenId);
  if (!selected) throw new Error(`Selected UI preview screen '${input.selectedScreenId}' was not provided.`);

  const screenDocument = composeUiPreviewDocument({
    title: selected.name || input.title,
    html: selected.html,
    css: selected.css,
    js: selected.js,
  });
  const title = escapeHtmlText(input.title ?? 'DevFlow UI Preview');
  const links = input.screens.map((screen) => {
    const isSelected = screen.screenId === input.selectedScreenId;
    const current = isSelected ? ' aria-current="page"' : '';
    const selectedLabel = isSelected ? '<span class="selected-label">Selected</span>' : '';
    return `<a href="${escapeHtmlAttribute(screen.href)}"${current}>${escapeHtmlText(screen.name)}${selectedLabel}</a>`;
  }).join('');

  return {
    csp: UI_PREVIEW_WORKSPACE_CSP,
    html: `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${UI_PREVIEW_WORKSPACE_CSP}">
<title>${title}</title>
<style>
:root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
* { box-sizing: border-box; }
html, body { width: 100%; height: 100%; margin: 0; }
body { display: grid; grid-template-rows: auto minmax(0, 1fr); background: #f7f7f8; color: #18181b; }
nav { display: flex; gap: 4px; align-items: center; overflow-x: auto; padding: 8px 10px; border-bottom: 1px solid #e4e4e7; background: #fff; }
nav a { flex: 0 0 auto; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 6px 10px; border-radius: 6px; color: inherit; text-decoration: none; font-size: 13px; line-height: 18px; }
nav a:hover { background: #f4f4f5; }
nav a:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
nav a[aria-current="page"] { font-weight: 700; text-decoration: underline; text-underline-offset: 4px; }
.selected-label { font-size: 11px; font-weight: 600; }
iframe { width: 100%; height: 100%; border: 0; background: #fff; }
</style>
</head>
<body data-ui-preview-workspace>
<nav aria-label="Preview screens">${links}</nav>
<iframe title="Preview: ${escapeHtmlAttribute(selected.name)}" sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc="${escapeHtmlAttribute(screenDocument.html)}"></iframe>
</body>
</html>`,
  };
}
