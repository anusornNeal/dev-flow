import fs from 'node:fs';
import path from 'node:path';
import type {
  AtlasAgentEvidence,
  AtlasAgentOverlayDiagnostic,
  Project,
  ProjectAtlas,
  ProjectAtlasAgentOverlay,
  ProjectAtlasAgentUpdatePatch,
} from '../../types.js';
import { readAtlasCache, writeAtlasCache } from './projectAtlasCacheService.js';

export interface ApplyProjectAtlasAgentUpdateOptions {
  now?: string;
  maxPayloadBytes?: number;
}

export interface ProjectAtlasAgentUpdateResult {
  ok: boolean;
  projectId: string;
  overlay?: ProjectAtlasAgentOverlay;
  diagnostics: AtlasAgentOverlayDiagnostic[];
}

const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
const MAX_COLLECTION_ITEMS = 100;

export function applyProjectAtlasAgentUpdatePatch(
  project: Project,
  patch: unknown,
  options: ApplyProjectAtlasAgentUpdateOptions = {},
): ProjectAtlasAgentUpdateResult {
  const cached = readAtlasCache({ projectId: project.id });
  const atlas = cached.atlas;
  const diagnostics = validateAgentPatch(project, atlas, patch, options);
  if (diagnostics.length > 0) {
    return { ok: false, projectId: project.id, diagnostics };
  }

  const typedPatch = patch as ProjectAtlasAgentUpdatePatch;
  const overlay: ProjectAtlasAgentOverlay = {
    status: 'applied',
    updatedAt: options.now ?? new Date().toISOString(),
    base: typedPatch.base,
    provenance: typedPatch.provenance,
    diagnostics: [],
    domains: (typedPatch.domains ?? []).map((domain) => ({ ...domain, origin: 'inferred' as const })),
    summaries: typedPatch.summaries ?? [],
    inferredRelationships: typedPatch.inferredRelationships ?? [],
    readOrder: typedPatch.readOrder ?? [],
    warnings: typedPatch.warnings ?? [],
  };

  writeAtlasCache({ atlas: { ...atlas, agentOverlay: overlay } });
  return { ok: true, projectId: project.id, overlay, diagnostics: [] };
}

function validateAgentPatch(
  project: Project,
  atlas: ProjectAtlas,
  patch: unknown,
  options: ApplyProjectAtlasAgentUpdateOptions,
) {
  const diagnostics: AtlasAgentOverlayDiagnostic[] = [];
  const maxBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const payloadBytes = Buffer.byteLength(JSON.stringify(patch ?? null), 'utf8');
  if (payloadBytes > maxBytes) {
    return [diagnostic('PATCH_TOO_LARGE', `Project Atlas agent update patch size ${payloadBytes} exceeds ${maxBytes} bytes.`)];
  }

  if (!patch || typeof patch !== 'object') {
    return [diagnostic('INVALID_PATCH', 'Project Atlas agent update patch must be an object.')];
  }

  const candidate = patch as Partial<ProjectAtlasAgentUpdatePatch>;
  if (candidate.projectId !== project.id || candidate.projectId !== atlas.projectId) {
    diagnostics.push(diagnostic('PROJECT_MISMATCH', 'Patch projectId must match the project and Atlas cache projectId.'));
  }
  if (!project.localPath) {
    diagnostics.push(diagnostic('PROJECT_LOCAL_PATH_MISSING', 'Project localPath is required to validate Atlas evidence paths.'));
  }
  validateBase(atlas, candidate, diagnostics);
  validateProvenance(candidate, diagnostics);

  const nodes = new Set(atlas.nodes.map((node) => node.id));
  const nodePathById = new Map(atlas.nodes.map((node) => [node.id, node.path]));
  const deterministicEdgeIds = new Set(atlas.edges.map((edge) => edge.id));
  const root = project.localPath ?? '';

  validateCollection('domains', candidate.domains, diagnostics, (item, index) => {
    if (!item.id || !item.name) diagnostics.push(diagnostic('INVALID_DOMAIN', `Domain at index ${index} requires id and name.`));
    validateNodeIds(item.nodeIds, nodes, diagnostics, `domains[${index}].nodeIds`);
    validateEvidenceBlocks(item.evidence, root, nodes, nodePathById, diagnostics, `domains[${index}]`);
  });

  validateCollection('summaries', candidate.summaries, diagnostics, (item, index) => {
    validateNodeId(item.nodeId, nodes, diagnostics, `summaries[${index}].nodeId`);
    if (!item.summary) diagnostics.push(diagnostic('INVALID_SUMMARY', `Summary at index ${index} requires summary text.`));
    validateEvidenceBlocks(item.evidence, root, nodes, nodePathById, diagnostics, `summaries[${index}]`);
  });

  validateCollection('inferredRelationships', candidate.inferredRelationships, diagnostics, (item, index) => {
    if (!item.id || deterministicEdgeIds.has(item.id)) {
      diagnostics.push(diagnostic('INVALID_RELATIONSHIP', `Inferred relationship at index ${index} requires a unique non-deterministic id.`));
    }
    validateNodeId(item.source, nodes, diagnostics, `inferredRelationships[${index}].source`);
    validateNodeId(item.target, nodes, diagnostics, `inferredRelationships[${index}].target`);
    if (!item.summary) diagnostics.push(diagnostic('INVALID_RELATIONSHIP', `Inferred relationship at index ${index} requires summary text.`));
    validateEvidenceBlocks(item.evidence, root, nodes, nodePathById, diagnostics, `inferredRelationships[${index}]`);
  });

  validateCollection('readOrder', candidate.readOrder, diagnostics, (item, index) => {
    validateNodeId(item.nodeId, nodes, diagnostics, `readOrder[${index}].nodeId`);
    if (item.path && nodePathById.get(item.nodeId) !== item.path) {
      diagnostics.push(diagnostic('READ_ORDER_PATH_MISMATCH', `Read order path '${item.path}' does not match node '${item.nodeId}'.`, item.path, item.nodeId));
    }
    if (!item.reason) diagnostics.push(diagnostic('INVALID_READ_ORDER', `Read order item at index ${index} requires a reason.`));
    validateEvidenceBlocks(item.evidence, root, nodes, nodePathById, diagnostics, `readOrder[${index}]`);
  });

  validateCollection('warnings', candidate.warnings, diagnostics, (item, index) => {
    if (!item.message) diagnostics.push(diagnostic('INVALID_WARNING', `Warning at index ${index} requires a message.`));
    if (!['info', 'warning', 'error'].includes(String(item.severity))) {
      diagnostics.push(diagnostic('INVALID_WARNING', `Warning at index ${index} has invalid severity.`));
    }
    validateEvidenceBlocks(item.evidence, root, nodes, nodePathById, diagnostics, `warnings[${index}]`);
  });

  return diagnostics;
}

function validateBase(atlas: ProjectAtlas, patch: Partial<ProjectAtlasAgentUpdatePatch>, diagnostics: AtlasAgentOverlayDiagnostic[]) {
  if (!patch.base || typeof patch.base !== 'object') {
    diagnostics.push(diagnostic('BASE_REQUIRED', 'Patch base Atlas metadata is required.'));
    return;
  }
  if (patch.base.generatedAt !== atlas.freshness.generatedAt) {
    diagnostics.push(diagnostic('STALE_BASE', 'Patch base generatedAt does not match the current Atlas cache.'));
  }
  if ((patch.base.repoFingerprint ?? '') !== (atlas.freshness.repoFingerprint ?? '')) {
    diagnostics.push(diagnostic('STALE_BASE', 'Patch base repoFingerprint does not match the current Atlas cache.'));
  }
  if (patch.base.nodeCount !== atlas.nodes.length || patch.base.edgeCount !== atlas.edges.length) {
    diagnostics.push(diagnostic('STALE_BASE', 'Patch base nodeCount/edgeCount does not match the current Atlas cache.'));
  }
}

function validateProvenance(patch: Partial<ProjectAtlasAgentUpdatePatch>, diagnostics: AtlasAgentOverlayDiagnostic[]) {
  if (!patch.provenance?.provider) {
    diagnostics.push(diagnostic('PROVENANCE_REQUIRED', 'Patch provenance.provider is required.'));
  }
}

function validateCollection<T>(
  name: string,
  value: T[] | undefined,
  diagnostics: AtlasAgentOverlayDiagnostic[],
  validateItem: (item: T, index: number) => void,
) {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    diagnostics.push(diagnostic('INVALID_COLLECTION', `Patch ${name} must be an array.`));
    return;
  }
  if (value.length > MAX_COLLECTION_ITEMS) {
    diagnostics.push(diagnostic('COLLECTION_TOO_LARGE', `Patch ${name} cannot contain more than ${MAX_COLLECTION_ITEMS} items.`));
    return;
  }
  value.forEach(validateItem);
}

function validateNodeIds(
  nodeIds: string[] | undefined,
  nodes: Set<string>,
  diagnostics: AtlasAgentOverlayDiagnostic[],
  label: string,
) {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    diagnostics.push(diagnostic('NODE_IDS_REQUIRED', `${label} must include at least one Atlas node id.`));
    return;
  }
  for (const nodeId of nodeIds) validateNodeId(nodeId, nodes, diagnostics, label);
}

function validateNodeId(
  nodeId: string | undefined,
  nodes: Set<string>,
  diagnostics: AtlasAgentOverlayDiagnostic[],
  label: string,
) {
  if (!nodeId || !nodes.has(nodeId)) {
    diagnostics.push(diagnostic('UNKNOWN_NODE', `${label} references unknown Atlas node '${nodeId ?? ''}'.`, undefined, nodeId));
  }
}

function validateEvidenceBlocks(
  evidence: AtlasAgentEvidence[] | undefined,
  root: string,
  nodes: Set<string>,
  nodePathById: Map<string, string | undefined>,
  diagnostics: AtlasAgentOverlayDiagnostic[],
  label: string,
) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    diagnostics.push(diagnostic('EVIDENCE_REQUIRED', `${label} requires at least one evidence block.`));
    return;
  }
  for (const block of evidence) {
    validateNodeId(block.nodeId, nodes, diagnostics, `${label}.evidence.nodeId`);
    if (!block.path || path.isAbsolute(block.path) || block.path.split(/[\\/]/).includes('..')) {
      diagnostics.push(diagnostic('INVALID_EVIDENCE_PATH', `${label} evidence path must be a relative repo path.`, block.path, block.nodeId));
      continue;
    }
    const expectedPath = nodePathById.get(block.nodeId);
    if (expectedPath && expectedPath !== block.path) {
      diagnostics.push(diagnostic('EVIDENCE_NODE_PATH_MISMATCH', `${label} evidence path does not match the referenced node.`, block.path, block.nodeId));
    }
    const absolutePath = path.resolve(root, block.path);
    const absoluteRoot = path.resolve(root);
    if (!absolutePath.startsWith(absoluteRoot + path.sep) && absolutePath !== absoluteRoot) {
      diagnostics.push(diagnostic('INVALID_EVIDENCE_PATH', `${label} evidence path escapes the project root.`, block.path, block.nodeId));
      continue;
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      diagnostics.push(diagnostic('MISSING_EVIDENCE_PATH', `${label} evidence path does not exist in the repo: ${block.path}`, block.path, block.nodeId));
    }
    if (block.startLine !== undefined && (!Number.isInteger(block.startLine) || block.startLine < 1)) {
      diagnostics.push(diagnostic('INVALID_SOURCE_SPAN', `${label} evidence startLine must be a positive integer.`, block.path, block.nodeId));
    }
    if (block.endLine !== undefined && (!Number.isInteger(block.endLine) || block.endLine < (block.startLine ?? 1))) {
      diagnostics.push(diagnostic('INVALID_SOURCE_SPAN', `${label} evidence endLine must be greater than or equal to startLine.`, block.path, block.nodeId));
    }
  }
}

function diagnostic(code: string, message: string, evidencePath?: string, nodeId?: string): AtlasAgentOverlayDiagnostic {
  return {
    code,
    message,
    severity: 'error',
    path: evidencePath,
    nodeId,
  };
}
