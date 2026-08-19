import type { JsonValue, UiPreviewDesignGateAuthorityRef, UiPreviewDesignGateCategory, UiPreviewDesignGateExceptionRef, UiPreviewScreen, UiPreviewViewport, UiSpecV1 } from '../domain/uiPreview.js';
import { UI_PREVIEW_SCREEN_ID_PATTERN, UiPreviewError } from '../domain/uiPreview.js';

export const UI_PREVIEW_LIMITS = Object.freeze({
  htmlBytes: 1_000_000,
  cssBytes: 500_000,
  jsBytes: 500_000,
  specBytes: 250_000,
  titleBytes: 4_000,
  screenIdBytes: 120,
  screenNameBytes: 4_000,
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
  html?: string;
  css?: string | null;
  js?: string | null;
  spec?: unknown;
  screens?: unknown;
  defaultScreenId?: unknown;
  viewport?: Partial<UiPreviewViewport> | null;
}

export interface NormalizedUiPreviewInput {
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  screens: UiPreviewScreen[];
  defaultScreenId: string;
  viewport: UiPreviewViewport;
}

function normalizeScreenId(value: unknown, path: string) {
  const screenId = assertStringWithin(path, value, UI_PREVIEW_LIMITS.screenIdBytes);
  if (!UI_PREVIEW_SCREEN_ID_PATTERN.test(screenId)) {
    validationError(`${path} must be a URL-safe opaque screen identifier.`);
  }
  return screenId;
}

function normalizeScreen(value: unknown, index: number): UiPreviewScreen {
  if (!value || typeof value !== 'object' || Array.isArray(value)) validationError(`screens[${index}] must be an object.`);
  const input = value as Record<string, unknown>;
  const screenId = normalizeScreenId(input.screenId, `screens[${index}].screenId`);
  const name = assertStringWithin(`screens[${index}].name`, input.name, UI_PREVIEW_LIMITS.screenNameBytes);
  const html = assertStringWithin(`screens[${index}].html`, input.html, UI_PREVIEW_LIMITS.htmlBytes);
  if (OUTER_DOCUMENT_PATTERN.test(html)) validationError(`screens[${index}].html must be a body fragment; complete outer document wrappers are not allowed.`);
  const css = assertStringWithin(`screens[${index}].css`, input.css, UI_PREVIEW_LIMITS.cssBytes, { allowEmpty: true });
  const js = assertStringWithin(`screens[${index}].js`, input.js, UI_PREVIEW_LIMITS.jsBytes, { allowEmpty: true });
  const spec = normalizeUiSpecV1(input.spec);
  return { screenId, name, html, css, js, spec };
}

export function normalizeUiPreviewInput(input: NormalizeUiPreviewInput): NormalizedUiPreviewInput {
  const title = input.title === '' || input.title === null || input.title === undefined
    ? null
    : assertStringWithin('title', input.title, UI_PREVIEW_LIMITS.titleBytes, { allowEmpty: true });
  const viewport = normalizeUiPreviewViewport(input.viewport);
  const hasScreens = input.screens !== undefined;
  const hasLegacySource = ['html', 'css', 'js', 'spec'].some((key) => Object.prototype.hasOwnProperty.call(input, key));

  if (hasScreens && hasLegacySource) validationError('screens cannot be mixed with legacy html/css/js/spec source fields.');

  if (hasScreens) {
    if (!Array.isArray(input.screens) || input.screens.length === 0) validationError('screens must be a non-empty array.');
    const screens = input.screens.map((screen, index) => normalizeScreen(screen, index));
    const uniqueIds = new Set(screens.map((screen) => screen.screenId));
    if (uniqueIds.size !== screens.length) validationError('screens must use unique screenId values.');
    const defaultScreenId = input.defaultScreenId === undefined
      ? screens[0].screenId
      : normalizeScreenId(input.defaultScreenId, 'defaultScreenId');
    const defaultScreen = screens.find((screen) => screen.screenId === defaultScreenId);
    if (!defaultScreen) validationError('defaultScreenId must reference an existing screen.');
    return {
      title,
      html: defaultScreen.html,
      css: defaultScreen.css,
      js: defaultScreen.js,
      spec: defaultScreen.spec,
      screens,
      defaultScreenId,
      viewport,
    };
  }

  if (input.defaultScreenId !== undefined) validationError('defaultScreenId is only valid with canonical screens input.');
  const html = assertStringWithin('html', input.html, UI_PREVIEW_LIMITS.htmlBytes);
  if (OUTER_DOCUMENT_PATTERN.test(html)) validationError('html must be a body fragment; complete outer document wrappers are not allowed.');
  const css = assertStringWithin('css', input.css ?? '', UI_PREVIEW_LIMITS.cssBytes, { allowEmpty: true });
  const js = assertStringWithin('js', input.js ?? '', UI_PREVIEW_LIMITS.jsBytes, { allowEmpty: true });
  const spec = normalizeUiSpecV1(input.spec);
  const screens: UiPreviewScreen[] = [{
    screenId: 'main',
    name: spec.summary.screen.trim() || title?.trim() || 'Main',
    html,
    css,
    js,
    spec,
  }];
  return { title, html, css, js, spec, screens, defaultScreenId: 'main', viewport };
}

export const UI_PREVIEW_DESIGN_GATE_LIMITS = Object.freeze({
  exceptionRefs: 16,
  targetsPerException: 16,
  idBytes: 240,
});

const UI_PREVIEW_DESIGN_GATE_CATEGORIES = new Set<UiPreviewDesignGateCategory>([
  'project-style',
  'accessibility',
  'interaction',
  'destructive-safety',
  'aesthetic-heuristic',
]);

function normalizeGateStringArray(value: unknown, path: string) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > UI_PREVIEW_DESIGN_GATE_LIMITS.targetsPerException) {
    validationError(`${path} must be an array with at most ${UI_PREVIEW_DESIGN_GATE_LIMITS.targetsPerException} entries.`);
  }
  return value.map((entry, index) => assertStringWithin(`${path}[${index}]`, entry, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes));
}

function normalizeGateCategories(value: unknown, path: string) {
  const categories = normalizeGateStringArray(value, path);
  for (const category of categories) {
    if (!UI_PREVIEW_DESIGN_GATE_CATEGORIES.has(category as UiPreviewDesignGateCategory)) {
      validationError(`${path} contains unsupported category '${category}'.`);
    }
  }
  return categories as UiPreviewDesignGateCategory[];
}

function normalizeGateAuthority(value: unknown, path: string): UiPreviewDesignGateAuthorityRef | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) validationError(`${path} must be an object.`);
  const input = value as Record<string, unknown>;
  if (input.type !== 'task-requirement' && input.type !== 'frozen-ui-design') {
    validationError(`${path}.type must be task-requirement or frozen-ui-design.`);
  }
  if (typeof input.current !== 'boolean') validationError(`${path}.current must be boolean.`);
  const authority: UiPreviewDesignGateAuthorityRef = {
    type: input.type,
    authorityId: assertStringWithin(`${path}.authorityId`, input.authorityId, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes),
    taskId: assertStringWithin(`${path}.taskId`, input.taskId, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes),
    projectId: assertStringWithin(`${path}.projectId`, input.projectId, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes),
    current: input.current,
    authorizedRuleIds: normalizeGateStringArray(input.authorizedRuleIds, `${path}.authorizedRuleIds`),
    authorizedCategories: normalizeGateCategories(input.authorizedCategories, `${path}.authorizedCategories`),
  };
  if (authority.type === 'frozen-ui-design') {
    if (input.evidenceId !== undefined) {
      authority.evidenceId = assertStringWithin(`${path}.evidenceId`, input.evidenceId, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes);
    }
    if (input.frozenRevision !== undefined) {
      const revision = Number(input.frozenRevision);
      if (!Number.isInteger(revision) || revision < 1) validationError(`${path}.frozenRevision must be a positive integer.`);
      authority.frozenRevision = revision;
    }
  }
  return authority;
}

export function normalizeUiPreviewDesignGateExceptionRefs(value: unknown): UiPreviewDesignGateExceptionRef[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > UI_PREVIEW_DESIGN_GATE_LIMITS.exceptionRefs) {
    validationError(`exceptionRefs must be an array with at most ${UI_PREVIEW_DESIGN_GATE_LIMITS.exceptionRefs} entries.`);
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) validationError(`exceptionRefs[${index}] must be an object.`);
    const input = entry as Record<string, unknown>;
    return {
      exceptionId: assertStringWithin(`exceptionRefs[${index}].exceptionId`, input.exceptionId, UI_PREVIEW_DESIGN_GATE_LIMITS.idBytes),
      ruleIds: normalizeGateStringArray(input.ruleIds, `exceptionRefs[${index}].ruleIds`),
      categories: normalizeGateCategories(input.categories, `exceptionRefs[${index}].categories`),
      authority: normalizeGateAuthority(input.authority, `exceptionRefs[${index}].authority`),
    };
  });
}
