export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface UiSpecV1 extends Record<string, JsonValue> {
  schemaVersion: 1;
  summary: { screen: string; [key: string]: JsonValue };
}

export interface UiPreviewViewport {
  width: number;
  height: number;
  deviceScaleFactor: number;
}

export interface UiPreviewRevision {
  previewId: string;
  revision: number;
  title: string | null;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt: string;
}

export interface UiPreviewRecord {
  id: string;
  taskId: string | null;
  latestRevision: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskUiEvidence {
  evidenceId: string;
  taskId: string;
  previewId: string;
  frozenRevision: number;
  frozenSpec: UiSpecV1;
  screenshotArtifactId: string;
  screenshotWidth: number;
  screenshotHeight: number;
  screenshotSha256: string | null;
  isCurrent: boolean;
  createdAt: string;
  supersededAt: string | null;
  supersededByEvidenceId: string | null;
}

export class UiPreviewError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UiPreviewError';
  }
}

export class UiPreviewNotFoundError extends UiPreviewError {
  constructor(previewId: string) {
    super('UI_PREVIEW_NOT_FOUND', `UI preview '${previewId}' was not found.`);
  }
}

export class UiPreviewRevisionConflictError extends UiPreviewError {
  constructor(previewId: string, expectedRevision: number, actualRevision: number) {
    super('UI_PREVIEW_REVISION_CONFLICT', `UI preview '${previewId}' is at revision ${actualRevision}, not expected revision ${expectedRevision}.`);
  }
}

export class UiPreviewTaskConflictError extends UiPreviewError {
  constructor(previewId: string, currentTaskId: string, requestedTaskId: string) {
    super('UI_PREVIEW_TASK_CONFLICT', `UI preview '${previewId}' is already bound to task '${currentTaskId}' and cannot be rebound to '${requestedTaskId}'.`);
  }
}

export class UiPreviewIdempotencyConflictError extends UiPreviewError {
  constructor(operation: string, key: string) {
    super('UI_PREVIEW_IDEMPOTENCY_CONFLICT', `Idempotency key '${key}' for operation '${operation}' was already used for a different request.`);
  }
}
