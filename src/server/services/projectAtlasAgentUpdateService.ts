import fs from 'node:fs';
import path from 'node:path';
import type {
  AtlasAgentOverlayDiagnostic,
  AtlasDomain,
  AtlasEdge,
  AtlasEvidencePath,
  AtlasNode,
  Project,
  ProjectAtlas,
  ProjectAtlasAgentUpdatePatch,
} from '../../types.js';
import { writeAtlasCache } from './projectAtlasCacheService.js';

export interface ApplyProjectAtlasAgentUpdateOptions {
  now?: string;
  maxPayloadBytes?: number;
}

export interface ProjectAtlasAgentUpdateResult {
  ok: boolean;
  projectId: string;
  atlas?: ProjectAtlas;
  diagnostics: AtlasAgentOverlayDiagnostic[];
}

const DEFAULT_MAX_PATCH_BYTES = 64 * 1024;
const MAX_COLLECTION_ITEMS = 1000;

export function applyProjectAtlasAgentUpdatePatch(
  project: Project,
  patch: unknown,
  options: ApplyProjectAtlasAgentUpdateOptions = {},
): ProjectAtlasAgentUpdateResult {
  const diagnostics = validateAuthoredAtlas(project, patch, options);
  if (diagnostics.length > 0) {
    return { ok: false, projectId: project.id, diagnostics };
  }

  const authored = patch as ProjectAtlasAgentUpdatePatch;
  const atlas: ProjectAtlas = {
    schemaVersion: 1,
    projectId: project.id,
    nodes: authored.nodes,
    edges: authored.edges,
    domains: authored.domains,
    flows: authored.flows ?? [],
    summary: authored.summary ?? {},
    freshness: {
      generatedAt: authored.generatedAt ?? options.now ?? new Date().toISOString(),
      repoFingerprint: authored.repoFingerprint,
      scanMode: 'task-focused',
      status: 'fresh',
    },
    authoring: {
      updatedAt: options.now ?? new Date().toISOString(),
      provenance: authored.provenance,
      coverage: authored.coverage,
      groupingRationale: authored.groupingRationale,
      evidence: authored.evidence ?? [],
      readOrder: authored.readOrder ?? [],
      warnings: authored.warnings ?? [],
    },
  };

  writeAtlasCache({ atlas });
  return { ok: true, projectId: project.id, atlas, diagnostics: [] };
}

function validateAuthoredAtlas(
  project: Project,
  patch: unknown,
  options: ApplyProjectAtlasAgentUpdateOptions,
) {
  const maxBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PATCH_BYTES;
  const payloadBytes = Buffer.byteLength(JSON.stringify(patch ?? null), 'utf8');
  if (payloadBytes > maxBytes) {
    return [diagnostic('PATCH_TOO_LARGE', `Project Atlas authored payload size ${payloadBytes} exceeds ${maxBytes} bytes.`)];
  }
  if (!patch || typeof patch !== 'object') {
    return [diagnostic('INVALID_PATCH', 'Project Atlas authored payload must be an object.')];
  }

  const candidate = patch as Partial<ProjectAtlasAgentUpdatePatch>;
  const diagnostics: AtlasAgentOverlayDiagnostic[] = [];
  if (candidate.projectId !== project.id) {
    diagnostics.push(diagnostic('PROJECT_MISMATCH', 'Authored Atlas projectId must match the project.'));
  }
  if (!project.localPath) {
    diagnostics.push(diagnostic('PROJECT_LOCAL_PATH_MISSING', 'Project localPath is required to validate Atlas evidence paths.'));
  }
  if (!candidate.provenance?.provider) {
    diagnostics.push(diagnostic('PROVENANCE_REQUIRED', 'Authored Atlas provenance.provider is required.'));
  }
  if (!candidate.coverage || !Array.isArray(candidate.coverage.notes) || !Array.isArray(candidate.coverage.skippedAreas)) {
    diagnostics.push(diagnostic('COVERAGE_REQUIRED', 'Authored Atlas coverage notes and skippedAreas are required.'));
  }
  if (!candidate.groupingRationale?.summary) {
    diagnostics.push(diagnostic('GROUPING_RATIONALE_REQUIRED', 'Authored Atlas groupingRationale.summary is required.'));
  }

  const nodes = validateNodes(candidate.nodes, diagnostics);
  validateEdges(candidate.edges, nodes, diagnostics);
  validateDomains(candidate.domains, nodes, diagnostics);
  validateReadOrder(candidate.readOrder, nodes, diagnostics);

  const root = project.localPath ?? '';
  validateEvidenceBlocks(candidate.evidence, root, nodes, diagnostics, 'evidence', { required: false });
  candidate.groupingRationale?.domainRationales?.forEach((rationale, index) => {
    if (!rationale.domainId || !rationale.rationale) {
      diagnostics.push(diagnostic('INVALID_GROUPING_RATIONALE', `Grouping rationale at index ${index} requires domainId and rationale.`));
    }
    validateEvidenceBlocks(rationale.evidence, root, nodes, diagnostics, `groupingRationale.domainRationales[${index}].evidence`, { required: false });
  });
  candidate.readOrder?.forEach((item, index) => {
    validateEvidenceBlocks(item.evidence, root, nodes, diagnostics, `readOrder[${index}].evidence`, { required: false });
  });
  candidate.warnings?.forEach((item, index) => {
    if (!item.message || !['info', 'warning', 'error'].includes(String(item.severity))) {
      diagnostics.push(diagnostic('INVALID_WARNING', `Warning at index ${index} requires message and valid severity.`));
    }
    validateEvidenceBlocks(item.evidence, root, nodes, diagnostics, `warnings[${index}].evidence`, { required: false });
  });
  candidate.domains?.forEach((domain, index) => {
    const evidence = Array.isArray(domain.metadata?.evidence) ? domain.metadata.evidence as AtlasEvidencePath[] : undefined;
    validateEvidenceBlocks(evidence, root, nodes, diagnostics, `domains[${index}].metadata.evidence`, { required: false });
  });

  return diagnostics;
}

function validateNodes(nodes: AtlasNode[] | undefined, diagnostics: AtlasAgentOverlayDiagnostic[]) {
  const ids = new Set<string>();
  if (!Array.isArray(nodes)) {
    diagnostics.push(diagnostic('NODES_REQUIRED', 'Authored Atlas nodes must be an array.'));
    return ids;
  }
  if (nodes.length > MAX_COLLECTION_ITEMS) {
    diagnostics.push(diagnostic('COLLECTION_TOO_LARGE', `Authored Atlas nodes cannot contain more than ${MAX_COLLECTION_ITEMS} items.`));
  }
  nodes.forEach((node, index) => {
    if (!node.id || !node.label || !node.kind) {
      diagnostics.push(diagnostic('INVALID_NODE', `Node at index ${index} requires id, label, and kind.`));
      return;
    }
    if (ids.has(node.id)) {
      diagnostics.push(diagnostic('DUPLICATE_NODE', `Duplicate Atlas node id '${node.id}'.`, node.path, node.id));
    }
    ids.add(node.id);
  });
  return ids;
}

function validateEdges(edges: AtlasEdge[] | undefined, nodes: Set<string>, diagnostics: AtlasAgentOverlayDiagnostic[]) {
  const ids = new Set<string>();
  if (!Array.isArray(edges)) {
    diagnostics.push(diagnostic('EDGES_REQUIRED', 'Authored Atlas edges must be an array.'));
    return;
  }
  edges.forEach((edge, index) => {
    if (!edge.id || !edge.source || !edge.target || !edge.kind || !edge.fact) {
      diagnostics.push(diagnostic('INVALID_EDGE', `Edge at index ${index} requires id, endpoints, kind, and fact.`));
    }
    if (ids.has(edge.id)) diagnostics.push(diagnostic('DUPLICATE_EDGE', `Duplicate Atlas edge id '${edge.id}'.`));
    ids.add(edge.id);
    validateNodeId(edge.source, nodes, diagnostics, `edges[${index}].source`);
    validateNodeId(edge.target, nodes, diagnostics, `edges[${index}].target`);
  });
}

function validateDomains(domains: AtlasDomain[] | undefined, nodes: Set<string>, diagnostics: AtlasAgentOverlayDiagnostic[]) {
  if (!Array.isArray(domains)) {
    diagnostics.push(diagnostic('DOMAINS_REQUIRED', 'Authored Atlas domains must be an array.'));
    return;
  }
  domains.forEach((domain, index) => {
    if (!domain.id || !domain.name) {
      diagnostics.push(diagnostic('INVALID_DOMAIN', `Domain at index ${index} requires id and name.`));
    }
    if (!Array.isArray(domain.nodeIds) || domain.nodeIds.length === 0) {
      diagnostics.push(diagnostic('NODE_IDS_REQUIRED', `domains[${index}].nodeIds must include at least one Atlas node id.`));
    }
    domain.nodeIds?.forEach((nodeId) => validateNodeId(nodeId, nodes, diagnostics, `domains[${index}].nodeIds`));
  });
}

function validateReadOrder(
  readOrder: ProjectAtlasAgentUpdatePatch['readOrder'],
  nodes: Set<string>,
  diagnostics: AtlasAgentOverlayDiagnostic[],
) {
  if (readOrder === undefined) return;
  if (!Array.isArray(readOrder)) {
    diagnostics.push(diagnostic('INVALID_READ_ORDER', 'Authored Atlas readOrder must be an array.'));
    return;
  }
  readOrder.forEach((item, index) => {
    validateNodeId(item.nodeId, nodes, diagnostics, `readOrder[${index}].nodeId`);
    if (!item.reason) diagnostics.push(diagnostic('INVALID_READ_ORDER', `Read order item at index ${index} requires a reason.`));
  });
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
  evidence: AtlasEvidencePath[] | undefined,
  root: string,
  nodes: Set<string>,
  diagnostics: AtlasAgentOverlayDiagnostic[],
  label: string,
  input: { required: boolean },
) {
  if (!Array.isArray(evidence) || evidence.length === 0) {
    if (input.required) diagnostics.push(diagnostic('EVIDENCE_REQUIRED', `${label} requires at least one evidence block.`));
    return;
  }
  for (const block of evidence) {
    if (block.nodeId) validateNodeId(block.nodeId, nodes, diagnostics, `${label}.nodeId`);
    if (!block.path || path.isAbsolute(block.path) || block.path.split(/[\\/]/).includes('..')) {
      diagnostics.push(diagnostic('INVALID_EVIDENCE_PATH', `${label} path must be a relative repo path.`, block.path, block.nodeId));
      continue;
    }
    const absolutePath = path.resolve(root, block.path);
    const absoluteRoot = path.resolve(root);
    if (!absolutePath.startsWith(absoluteRoot + path.sep) && absolutePath !== absoluteRoot) {
      diagnostics.push(diagnostic('INVALID_EVIDENCE_PATH', `${label} path escapes the project root.`, block.path, block.nodeId));
      continue;
    }
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      diagnostics.push(diagnostic('MISSING_EVIDENCE_PATH', `${label} path does not exist in the repo: ${block.path}`, block.path, block.nodeId));
    }
    if (block.startLine !== undefined && (!Number.isInteger(block.startLine) || block.startLine < 1)) {
      diagnostics.push(diagnostic('INVALID_SOURCE_SPAN', `${label} startLine must be a positive integer.`, block.path, block.nodeId));
    }
    if (block.endLine !== undefined && (!Number.isInteger(block.endLine) || block.endLine < (block.startLine ?? 1))) {
      diagnostics.push(diagnostic('INVALID_SOURCE_SPAN', `${label} endLine must be greater than or equal to startLine.`, block.path, block.nodeId));
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
