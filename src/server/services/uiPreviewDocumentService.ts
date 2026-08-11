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
