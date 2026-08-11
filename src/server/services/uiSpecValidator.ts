import type { JsonValue, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import { UiPreviewError } from '../domain/uiPreview.js';

export const UI_PREVIEW_LIMITS = Object.freeze({
  htmlBytes: 1_000_000,
  cssBytes: 500_000,
  jsBytes: 500_000,
  specBytes: 250_000,
  titleBytes: 4_000,
  minWidth: 320,
  maxWidth: 3840,
  minHeight: 200,
  maxHeight: 2160,
  minDeviceScaleFactor: 0.5,
  maxDeviceScaleFactor: 4,
});

export const DEFAULT_UI_PREVIEW_VIEWPORT: UiPreviewViewport = Object.freeze({
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
});

function validationError(message: string): never {
  throw new UiPreviewError('UI_PREVIEW_VALIDATION_FAILED', message);
}

function utf8Bytes(value: string) {
  return Buffer.byteLength(value, 'utf8');
}

function assertStringWithin(name: string, value: unknown, maxBytes: number, options: { allowEmpty?: boolean } = {}) {
  if (typeof value !== 'string') validationError(`${name} must be a string.`);
  if (!options.allowEmpty && value.trim().length === 0) validationError(`${name} must not be empty.`);
  const bytes = utf8Bytes(value);
  if (bytes > maxBytes) validationError(`${name} exceeds the ${maxBytes} UTF-8 byte size limit.`);
  return value;
}

function normalizeJsonValue(value: unknown, path: string, seen: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value as JsonValue;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) validationError(`${path} must contain only finite JSON numbers.`);
    return value;
  }
  if (typeof value !== 'object') validationError(`${path} must contain only JSON values.`);
  if (seen.has(value as object)) validationError(`${path} must not contain circular JSON values.`);
  seen.add(value as object);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (entry, index) => normalizeJsonValue(entry, `${path}[${index}]`, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) validationError(`${path} must contain only plain JSON objects.`);
    const input = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(input).sort((a, b) => a.localeCompare(b))) {
      output[key] = normalizeJsonValue(input[key], `${path}.${key}`, seen);
    }
    return output;
  } finally {
    seen.delete(value as object);
  }
}

export function normalizeUiSpecV1(value: unknown): UiSpecV1 {
  const normalized = normalizeJsonValue(value, 'spec', new WeakSet());
  if (!normalized || Array.isArray(normalized) || typeof normalized !== 'object') validationError('spec must be a JSON object.');
  const object = normalized as Record<string, JsonValue>;
  if (object.schemaVersion !== 1) validationError('spec.schemaVersion must be 1.');
  const summary = object.summary;
  if (!summary || Array.isArray(summary) || typeof summary !== 'object') validationError('spec.summary must be an object.');
  const screen = (summary as Record<string, JsonValue>).screen;
  if (typeof screen !== 'string' || !screen.trim()) validationError('spec.summary.screen must be a non-empty string.');
  const serialized = JSON.stringify(object);
  if (utf8Bytes(serialized) > UI_PREVIEW_LIMITS.specBytes) validationError(`spec exceeds the ${UI_PREVIEW_LIMITS.specBytes} UTF-8 byte size limit.`);
  return object as UiSpecV1;
}

export function normalizeUiPreviewViewport(value?: Partial<UiPreviewViewport> | null): UiPreviewViewport {
  const viewport = {
    width: value?.width ?? DEFAULT_UI_PREVIEW_VIEWPORT.width,
    height: value?.height ?? DEFAULT_UI_PREVIEW_VIEWPORT.height,
    deviceScaleFactor: value?.deviceScaleFactor ?? DEFAULT_UI_PREVIEW_VIEWPORT.deviceScaleFactor,
  };
  const validInteger = Number.isInteger(viewport.width) && Number.isInteger(viewport.height);
  const validBounds = viewport.width >= UI_PREVIEW_LIMITS.minWidth
    && viewport.width <= UI_PREVIEW_LIMITS.maxWidth
    && viewport.height >= UI_PREVIEW_LIMITS.minHeight
    && viewport.height <= UI_PREVIEW_LIMITS.maxHeight
    && Number.isFinite(viewport.deviceScaleFactor)
    && viewport.deviceScaleFactor >= UI_PREVIEW_LIMITS.minDeviceScaleFactor
    && viewport.deviceScaleFactor <= UI_PREVIEW_LIMITS.maxDeviceScaleFactor;
  if (!validInteger || !validBounds) validationError('viewport dimensions or deviceScaleFactor are outside supported bounds.');
  return viewport;
}

const OUTER_DOCUMENT_PATTERN = /<!doctype\b|<\s*html\b|<\s*head\b|<\s*body\b/i;

export interface NormalizeUiPreviewInput {
  title?: string | null;
  html: string;
  css?: string | null;
  js?: string | null;
  spec: unknown;
  viewport?: Partial<UiPreviewViewport> | null;
}

export function normalizeUiPreviewInput(input: NormalizeUiPreviewInput) {
  const html = assertStringWithin('html', input.html, UI_PREVIEW_LIMITS.htmlBytes);
  if (OUTER_DOCUMENT_PATTERN.test(html)) validationError('html must be a body fragment; complete outer document wrappers are not allowed.');
  const css = assertStringWithin('css', input.css ?? '', UI_PREVIEW_LIMITS.cssBytes, { allowEmpty: true });
  const js = assertStringWithin('js', input.js ?? '', UI_PREVIEW_LIMITS.jsBytes, { allowEmpty: true });
  const title = input.title === '' || input.title === null || input.title === undefined
    ? null
    : assertStringWithin('title', input.title, UI_PREVIEW_LIMITS.titleBytes, { allowEmpty: true });
  const spec = normalizeUiSpecV1(input.spec);
  const viewport = normalizeUiPreviewViewport(input.viewport);
  return { title, html, css, js, spec, viewport };
}
