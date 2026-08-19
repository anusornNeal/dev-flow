import { createHash } from 'node:crypto';
import type { UiPreviewDesignRenderAsset } from '../domain/uiPreview.js';

export type UiPreviewFontRenderability = 'not-requested' | 'available' | 'unavailable';

export interface UiPreviewFontSnapshotEntry {
  assetId: string;
  contentIdentity: string;
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  mimeType: 'font/woff2' | 'font/woff';
  format: 'woff2' | 'woff';
  dataUri: string;
}

export interface UiPreviewFontUnavailable {
  assetId: string;
  reasonCode: string;
}

export interface UiPreviewFontSnapshot {
  contextHash: string;
  fontRenderability: UiPreviewFontRenderability;
  fonts: UiPreviewFontSnapshotEntry[];
  unavailable: UiPreviewFontUnavailable[];
}

export const UI_PREVIEW_FONT_LIMITS = Object.freeze({
  maxFonts: 8,
  maxAssetBytes: 2 * 1024 * 1024,
  maxAggregateBytes: 6 * 1024 * 1024,
  maxFamilyBytes: 256,
});

const UI_PREVIEW_FONT_ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UI_PREVIEW_FONT_CONTEXT_HASH_PATTERN = /^[0-9a-f]{64}$/i;
const UI_PREVIEW_FONT_CONTENT_IDENTITY_PATTERN = /^sha256:([0-9a-f]{64})$/i;
const UI_PREVIEW_FONT_FORMATS = Object.freeze({
  'font/woff2': { format: 'woff2' as const, magic: 'wOF2' },
  'font/woff': { format: 'woff' as const, magic: 'wOFF' },
});

interface UiPreviewResolvedFont {
  assetId: string;
  bytes: Uint8Array;
}

export interface MaterializeUiPreviewFontsInput {
  contextHash: string;
  renderAssets: UiPreviewDesignRenderAsset[];
  resolvedFonts: UiPreviewResolvedFont[];
}

function fontUnavailable(assetId: string, reasonCode: string): UiPreviewFontUnavailable {
  return { assetId, reasonCode };
}

function isFontMetadataValid(asset: UiPreviewDesignRenderAsset) {
  const font = asset.font;
  if (!font) return false;
  if (typeof font.family !== 'string' || !font.family.trim() || Buffer.byteLength(font.family, 'utf8') > UI_PREVIEW_FONT_LIMITS.maxFamilyBytes) return false;
  if (!Number.isInteger(font.weight) || font.weight < 1 || font.weight > 1000) return false;
  if (font.style !== 'normal' && font.style !== 'italic') return false;
  if (!Number.isInteger(font.byteLength) || font.byteLength < 1) return false;
  return true;
}

function fontMagic(bytes: Uint8Array) {
  return Buffer.from(bytes.subarray(0, 4)).toString('ascii');
}

export function materializeUiPreviewFonts(input: MaterializeUiPreviewFontsInput): UiPreviewFontSnapshot {
  const contextHash = String(input?.contextHash || '').trim();
  const refs = Array.isArray(input?.renderAssets) ? input.renderAssets : [];
  const resolved = Array.isArray(input?.resolvedFonts) ? input.resolvedFonts : [];
  const fontRefs = refs.filter((asset) => asset?.kind === 'font');
  const requestedIds = [...new Set([...fontRefs.map((asset) => asset.assetId), ...resolved.map((entry) => entry.assetId)])].sort();
  if (requestedIds.length === 0) return { contextHash, fontRenderability: 'not-requested', fonts: [], unavailable: [] };

  const unavailable: UiPreviewFontUnavailable[] = [];
  const fonts: UiPreviewFontSnapshotEntry[] = [];
  if (!UI_PREVIEW_FONT_CONTEXT_HASH_PATTERN.test(contextHash)) {
    return { contextHash, fontRenderability: 'unavailable', fonts: [], unavailable: [fontUnavailable('context', 'FONT_CONTEXT_INVALID')] };
  }
  if (requestedIds.length > UI_PREVIEW_FONT_LIMITS.maxFonts) {
    return { contextHash, fontRenderability: 'unavailable', fonts: [], unavailable: [fontUnavailable('fonts', 'FONT_COUNT_EXCEEDED')] };
  }

  const refsById = new Map(refs.map((asset) => [asset.assetId, asset]));
  const resolvedById = new Map(resolved.map((entry) => [entry.assetId, entry]));
  let aggregateBytes = 0;

  for (const assetId of requestedIds) {
    if (!UI_PREVIEW_FONT_ASSET_ID_PATTERN.test(String(assetId || ''))) {
      unavailable.push(fontUnavailable(String(assetId || 'font'), 'FONT_REF_INVALID'));
      continue;
    }
    const ref = refsById.get(assetId);
    if (!ref || ref.kind !== 'font') {
      unavailable.push(fontUnavailable(assetId, 'FONT_REF_UNAUTHORIZED'));
      continue;
    }
    if (!isFontMetadataValid(ref) || !UI_PREVIEW_FONT_CONTENT_IDENTITY_PATTERN.test(ref.contentIdentity)) {
      unavailable.push(fontUnavailable(assetId, 'FONT_REF_INVALID'));
      continue;
    }
    const font = ref.font!;
    const format = UI_PREVIEW_FONT_FORMATS[font.mimeType as keyof typeof UI_PREVIEW_FONT_FORMATS];
    if (!format) {
      unavailable.push(fontUnavailable(assetId, 'FONT_TYPE_UNSUPPORTED'));
      continue;
    }
    const source = resolvedById.get(assetId);
    if (!source?.bytes || !(source.bytes instanceof Uint8Array)) {
      unavailable.push(fontUnavailable(assetId, 'FONT_BYTES_UNAVAILABLE'));
      continue;
    }
    const bytes = source.bytes;
    if (bytes.byteLength !== font.byteLength) {
      unavailable.push(fontUnavailable(assetId, 'FONT_BYTE_LENGTH_MISMATCH'));
      continue;
    }
    if (bytes.byteLength > UI_PREVIEW_FONT_LIMITS.maxAssetBytes) {
      unavailable.push(fontUnavailable(assetId, 'FONT_ASSET_TOO_LARGE'));
      continue;
    }
    if (aggregateBytes + bytes.byteLength > UI_PREVIEW_FONT_LIMITS.maxAggregateBytes) {
      unavailable.push(fontUnavailable(assetId, 'FONT_AGGREGATE_TOO_LARGE'));
      continue;
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    const identityMatch = ref.contentIdentity.match(UI_PREVIEW_FONT_CONTENT_IDENTITY_PATTERN);
    if (!identityMatch || digest.toLowerCase() !== identityMatch[1].toLowerCase()) {
      unavailable.push(fontUnavailable(assetId, 'FONT_CONTENT_IDENTITY_MISMATCH'));
      continue;
    }
    if (fontMagic(bytes) !== format.magic) {
      unavailable.push(fontUnavailable(assetId, 'FONT_TYPE_MISMATCH'));
      continue;
    }
    aggregateBytes += bytes.byteLength;
    fonts.push({
      assetId,
      contentIdentity: `sha256:${digest.toLowerCase()}`,
      family: font.family.trim(),
      weight: font.weight,
      style: font.style,
      mimeType: font.mimeType as 'font/woff2' | 'font/woff',
      format: format.format,
      dataUri: `data:${font.mimeType};base64,${Buffer.from(bytes).toString('base64')}`,
    });
  }

  fonts.sort((a, b) => a.family.localeCompare(b.family) || a.weight - b.weight || a.style.localeCompare(b.style) || a.assetId.localeCompare(b.assetId));
  unavailable.sort((a, b) => a.assetId.localeCompare(b.assetId) || a.reasonCode.localeCompare(b.reasonCode));
  return {
    contextHash,
    fontRenderability: unavailable.length > 0 ? 'unavailable' : fonts.length > 0 ? 'available' : 'not-requested',
    fonts,
    unavailable,
  };
}

function fontFaceCss(snapshot?: UiPreviewFontSnapshot) {
  if (!snapshot || snapshot.fonts.length === 0) return '';
  return snapshot.fonts.map((font) => `@font-face{font-family:${JSON.stringify(font.family)};src:url("${font.dataUri}") format("${font.format}");font-style:${font.style};font-weight:${font.weight};font-display:block;}`).join('\n');
}

export interface UiPreviewDocumentInput {
  title?: string | null;
  html: string;
  css?: string | null;
  js?: string | null;
  fontSnapshot?: UiPreviewFontSnapshot;
}

export interface UiPreviewDocument {
  html: string;
  csp: string;
  fontRenderability: UiPreviewFontRenderability;
  fontContentIdentities: string[];
  fontUnavailable: UiPreviewFontUnavailable[];
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
  const fontCss = fontFaceCss(input.fontSnapshot);
  const css = escapeRawTextClosingTag(`${fontCss}${fontCss && input.css ? '\n' : ''}${input.css ?? ''}`, 'style');
  const guard = escapeRawTextClosingTag(UI_PREVIEW_CAPABILITY_GUARD_SCRIPT, 'script');
  const js = escapeRawTextClosingTag(input.js ?? '', 'script');

  return {
    csp: UI_PREVIEW_CSP,
    fontRenderability: input.fontSnapshot?.fontRenderability ?? 'not-requested',
    fontContentIdentities: input.fontSnapshot?.fonts.map((font) => font.contentIdentity) ?? [],
    fontUnavailable: input.fontSnapshot?.unavailable.map((entry) => ({ ...entry })) ?? [],
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
    fontSnapshot: selected.fontSnapshot,
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
    fontRenderability: screenDocument.fontRenderability,
    fontContentIdentities: [...screenDocument.fontContentIdentities],
    fontUnavailable: screenDocument.fontUnavailable.map((entry) => ({ ...entry })),
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
