import type { AtlasDomain, AtlasEdge, AtlasNode, ProjectAtlas } from '../../types.js';
import { buildAtlasReadOrder, type AtlasReadOrderItem } from '../../lib/projectAtlasReadOrder.js';

export interface AtlasImpactWarning {
  type: 'missing-target-files' | 'target-file-conflict';
  message: string;
}

export interface AtlasImpactResult {
  changedFiles: string[];
  directNodes: AtlasNode[];
  domains: AtlasDomain[];
  relatedTests: AtlasNode[];
  readOrder: AtlasReadOrderItem[];
  neighborhood: {
    nodes: AtlasNode[];
    edges: AtlasEdge[];
  };
  warnings: AtlasImpactWarning[];
  compactSummary: string;
  markdown: string;
  json: Record<string, unknown>;
  mermaid: string;
}

export interface AtlasTaskFocusInput {
  title?: string;
  description?: string;
  repoContext?: string;
  targetFiles?: string[];
  checklist?: Array<{ text?: string } | string>;
  tags?: string[];
  branch?: string;
}

export function buildAtlasDiffImpact(atlas: ProjectAtlas, input: { changedFiles?: string[] } = {}): AtlasImpactResult {
  const changedFiles = normalizeFiles(input.changedFiles ?? []);
  return buildImpact(atlas, {
    changedFiles,
    directNodes: findNodesByFiles(atlas, changedFiles),
    warnings: [],
  });
}

export function buildTaskFocusedAtlasImpact(atlas: ProjectAtlas, task: AtlasTaskFocusInput): AtlasImpactResult {
  const targetFiles = normalizeFiles(task.targetFiles ?? []);
  const directNodes = targetFiles.length > 0
    ? findNodesByFiles(atlas, targetFiles)
    : findNodesByText(atlas, taskFocusText(task));
  const warnings = detectAtlasTargetFileWarnings(atlas, {
    targetFiles,
    suggestedNodeIds: directNodes.map((node) => node.id),
  });

  return buildImpact(atlas, {
    changedFiles: targetFiles,
    directNodes,
    warnings,
    title: task.title,
  });
}

export function detectAtlasTargetFileWarnings(
  atlas: ProjectAtlas,
  input: { targetFiles?: string[]; suggestedNodeIds?: string[] },
): AtlasImpactWarning[] {
  const targetFiles = normalizeFiles(input.targetFiles ?? []);
  const suggestedNodes = atlas.nodes.filter((node) => input.suggestedNodeIds?.includes(node.id) && node.path);
  if (targetFiles.length === 0 && suggestedNodes.length > 0) {
    return [{
      type: 'missing-target-files',
      message: `Task is missing targetFiles; Atlas suggests ${suggestedNodes.map((node) => node.path).join(', ')}.`,
    }];
  }

  const suggestedFiles = suggestedNodes.map((node) => normalizePath(node.path || node.label));
  const targetSetForCompare = new Set(targetFiles.map(comparePath));
  const conflicting = suggestedFiles.filter((file) => !targetSetForCompare.has(comparePath(file)));
  if (targetFiles.length > 0 && conflicting.length > 0) {
    return [{
      type: 'target-file-conflict',
      message: `Atlas suggestions conflict with explicit targetFiles: ${conflicting.join(', ')}. Do not override silently.`,
    }];
  }

  return [];
}

function buildImpact(
  atlas: ProjectAtlas,
  input: { changedFiles: string[]; directNodes: AtlasNode[]; warnings: AtlasImpactWarning[]; title?: string },
): AtlasImpactResult {
  const directIds = new Set(input.directNodes.map((node) => node.id));
  const neighborhoodEdges = atlas.edges.filter((edge) => directIds.has(edge.source) || directIds.has(edge.target));
  const neighborhoodIds = new Set([
    ...input.directNodes.map((node) => node.id),
    ...neighborhoodEdges.flatMap((edge) => [edge.source, edge.target]),
  ]);
  const neighborhoodNodes = atlas.nodes.filter((node) => neighborhoodIds.has(node.id));
  const relatedTests = neighborhoodNodes.filter(isTestNode);
  const domains = atlas.domains.filter((domain) => domain.nodeIds.some((nodeId) => neighborhoodIds.has(nodeId)));
  const readOrder = buildAtlasReadOrder(atlas, { nodeIds: [...neighborhoodIds], limit: 20 });
  const compactSummary = buildCompactSummary(input.title, domains, relatedTests, input.warnings);
  const json = {
    changedFiles: input.changedFiles,
    directNodes: input.directNodes,
    domains,
    relatedTests,
    readOrder,
    warnings: input.warnings,
    neighborhood: { nodes: neighborhoodNodes, edges: neighborhoodEdges },
  };

  return {
    changedFiles: input.changedFiles,
    directNodes: input.directNodes,
    domains,
    relatedTests,
    readOrder,
    neighborhood: { nodes: neighborhoodNodes, edges: neighborhoodEdges },
    warnings: input.warnings,
    compactSummary,
    markdown: renderImpactMarkdown(input.changedFiles, input.directNodes, domains, relatedTests, readOrder, input.warnings, neighborhoodNodes),
    json,
    mermaid: renderImpactMermaid(neighborhoodNodes, neighborhoodEdges),
  };
}

function findNodesByFiles(atlas: ProjectAtlas, files: string[]) {
  const normalized = files.map(comparePath);
  return atlas.nodes.filter((node) => {
    const nodePath = comparePath(node.path || node.label);
    return normalized.some((file) => nodePath === file || nodePath.endsWith(file) || file.endsWith(nodePath));
  });
}

function findNodesByText(atlas: ProjectAtlas, text: string) {
  const tokens = text.toLowerCase().match(/[a-z0-9_.\/-]{4,}/g) ?? [];
  if (tokens.length === 0) return [];
  return atlas.nodes.filter((node) => {
    const haystack = [node.id, node.label, node.path, node.verified?.description, node.inferred?.summary]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return tokens.some((token) => haystack.includes(token));
  });
}

function taskFocusText(task: AtlasTaskFocusInput) {
  return [
    task.title,
    task.description,
    task.repoContext,
    task.branch,
    ...(task.tags ?? []),
    ...(task.checklist ?? []).map((item) => typeof item === 'string' ? item : item.text),
  ].filter(Boolean).join(' ');
}

function renderImpactMarkdown(
  changedFiles: string[],
  directNodes: AtlasNode[],
  domains: AtlasDomain[],
  relatedTests: AtlasNode[],
  readOrder: AtlasReadOrderItem[],
  warnings: AtlasImpactWarning[],
  neighborhoodNodes: AtlasNode[],
) {
  return [
    '## Project Atlas Impact',
    '',
    '### Verified direct impact',
    ...(directNodes.length ? directNodes.map((node) => `- ${node.path ?? node.label}`) : ['- No direct Atlas node matched.']),
    '',
    '### Inferred broader impact',
    ...(domains.length ? domains.map((domain) => `- ${domain.name} (${domain.origin})`) : ['- No related domains surfaced.']),
    ...(changedFiles.length ? ['', '### Changed Files', ...changedFiles.map((file) => `- ${file}`)] : []),
    '',
    '### Related Tests',
    ...(relatedTests.length ? relatedTests.map((node) => `- ${node.path ?? node.label}`) : ['- No related tests surfaced.']),
    '',
    '### Recommended Read Order',
    ...(readOrder.length ? readOrder.map((item, index) => `${index + 1}. ${item.path ?? item.label} - ${item.reason}`) : ['1. Use repo context bundle before broad reads.']),
    ...(warnings.length ? ['', '### Warnings', ...warnings.map((warning) => `- ${warning.message}`)] : []),
    '',
    '### Output Boundary',
    `- Neighborhood nodes: ${neighborhoodNodes.length}`,
    '- Do not mutate task targetFiles automatically from Atlas warnings.',
  ].join('\n');
}

function renderImpactMermaid(nodes: AtlasNode[], edges: AtlasEdge[]) {
  const ids = new Map(nodes.map((node, index) => [node.id, `N${index}`]));
  return [
    'graph TD',
    ...nodes.map((node) => `  ${ids.get(node.id)}["${escapeMermaid(node.path ?? node.label)}"]`),
    ...edges
      .filter((edge) => ids.has(edge.source) && ids.has(edge.target))
      .map((edge) => `  ${ids.get(edge.source)} -->|${edge.kind}| ${ids.get(edge.target)}`),
  ].join('\n');
}

function buildCompactSummary(title: string | undefined, domains: AtlasDomain[], relatedTests: AtlasNode[], warnings: AtlasImpactWarning[]) {
  const domainText = domains.map((domain) => domain.name).join(', ') || 'no domains matched';
  return [
    title ? `${title}:` : 'Atlas impact:',
    domainText,
    relatedTests.length ? `${relatedTests.length} related test(s)` : 'no related tests surfaced',
    warnings.length ? `${warnings.length} warning(s)` : 'no warnings',
  ].join(' ');
}

function normalizeFiles(files: string[]) {
  return files.map(normalizePath).filter(Boolean);
}

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, '/');
}

function comparePath(value: string) {
  return normalizePath(value).toLowerCase();
}

function isTestNode(node: AtlasNode) {
  return node.kind === 'test' || /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i.test(node.path || node.label);
}

function escapeMermaid(value: string) {
  return value.replace(/\\/g, '/').replace(/"/g, '\\"');
}
