import { UI_PREVIEW_SCREEN_ID_PATTERN, UiPreviewError } from '../domain/uiPreview.js';

export interface ResolveUiPreviewUrlInput {
  previewId: string;
  revision?: number;
  screenId?: string;
  port: number;
}

export function resolveUiPreviewUrl(input: ResolveUiPreviewUrlInput) {
  if (!/^uip_[A-Za-z0-9_-]+$/.test(input.previewId)) {
    throw new UiPreviewError('UI_PREVIEW_INVALID_ID', 'previewId is not a generated UI preview id.');
  }
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
    throw new UiPreviewError('UI_PREVIEW_RUNTIME_UNAVAILABLE', 'A valid bound runtime port is required to resolve preview URLs.');
  }
  if (input.revision !== undefined && (!Number.isInteger(input.revision) || input.revision < 1)) {
    throw new UiPreviewError('UI_PREVIEW_INVALID_REVISION', 'revision must be a positive integer.');
  }
  if (input.screenId !== undefined && !UI_PREVIEW_SCREEN_ID_PATTERN.test(input.screenId)) {
    throw new UiPreviewError('UI_PREVIEW_INVALID_SCREEN_ID', 'screenId must be a URL-safe opaque UI preview screen id.');
  }
  const query = new URLSearchParams();
  if (input.revision !== undefined) query.set('revision', String(input.revision));
  if (input.screenId !== undefined) query.set('screenId', input.screenId);
  const suffix = query.size === 0 ? '' : `?${query.toString()}`;
  return `http://127.0.0.1:${input.port}/api/ui-previews/${input.previewId}/document${suffix}`;
}
