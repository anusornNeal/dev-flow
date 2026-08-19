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

export const UI_PREVIEW_SCREEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/;

export interface UiPreviewScreen {
  screenId: string;
  name: string;
  html: string;
  css: string;
  js: string;
  spec: UiSpecV1;
}

export interface UiPreviewWorkspaceRevision {
  previewId: string;
  revision: number;
  title: string | null;
  screens: UiPreviewScreen[];
  defaultScreenId: string;
  viewport: UiPreviewViewport;
  contentHash: string;
  createdAt: string;
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

export type UiPreviewDesignContextSufficiency = 'insufficient' | 'partial' | 'sufficient';

export interface UiPreviewDesignContextSource {
  path: string;
  startLine?: number;
  endLine?: number;
  trustClass: 'repo-evidence-untrusted';
  evidenceRole: 'project-foundation' | 'project-ui-reference' | 'project-repo-evidence';
}

export interface UiPreviewDesignRenderAsset {
  assetId: string;
  kind: string;
  contentIdentity: string;
}

export interface UiPreviewDesignContext {
  taskId: string | null;
  projectId: string;
  repositoryRevision: string;
  contextSchemaVersion: 1;
  gatePolicyVersion: string;
  contextHash: string;
  sufficiency: UiPreviewDesignContextSufficiency;
  reasonCodes: string[];
  visual: {
    colors: string[];
    fontFamilies: string[];
    fontWeights: string[];
    spacing: string[];
    radii: string[];
    dimensions: string[];
    iconConventions: string[];
    sharedComponents: string[];
    referenceScreens: string[];
  };
  ux: { ruleIds: string[] };
  unknowns: string[];
  sources: UiPreviewDesignContextSource[];
  renderAssets: UiPreviewDesignRenderAsset[];
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
