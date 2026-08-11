import { UiPreviewError } from '../domain/uiPreview.js';

export interface ResolveUiPreviewUrlInput {
  previewId: string;
  revision?: number;
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
  const revisionQuery = input.revision === undefined ? '' : `?revision=${input.revision}`;
  return `http://127.0.0.1:${input.port}/api/ui-previews/${input.previewId}/document${revisionQuery}`;
}
