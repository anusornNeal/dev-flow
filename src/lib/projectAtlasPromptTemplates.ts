import type { AtlasDomain, AtlasNode, ProjectAtlas } from '../types.js';
import { buildAtlasReadOrder } from './projectAtlasReadOrder.js';
import { buildNodeContext } from './projectAtlasViewModel.js';

export type ProjectAtlasPromptVariantId =
  | 'explain-project'
  | 'onboard-repo'
  | 'find-affected-files'
  | 'plan-implementation'
  | 'build-read-order'
  | 'explain-module'
  | 'analyze-diff-impact';

export interface ProjectAtlasPromptVariant {
  id: ProjectAtlasPromptVariantId;
  label: string;
}

export interface ProjectAtlasPromptTask {
  id?: string;
  title?: string;
  targetFiles?: string[];
}

export interface BuildProjectAtlasPromptInput {
  task?: ProjectAtlasPromptTask;
  selectedNodeId?: string;
  diffSummary?: string;
  limit?: number;
}

export const PROJECT_ATLAS_PROMPT_VARIANTS: ProjectAtlasPromptVariant[] = [
  { id: 'explain-project', label: 'Explain this project' },
  { id: 'onboard-repo', label: 'Onboard me to this repo' },
  { id: 'find-affected-files', label: 'Find affected files' },
  { id: 'plan-implementation', label: 'Plan implementation' },
  { id: 'build-read-order', label: 'Build agent read order' },
  { id: 'explain-module', label: 'Explain this module/node' },
  { id: 'analyze-diff-impact', label: 'Analyze diff impact' },
];

const INSTRUCTIONS: Record<ProjectAtlasPromptVariantId, string> = {
  'explain-project': 'Explain the project shape, major domains, and important entry points.',
  'onboard-repo': 'Onboard a new contributor with a concise tour and first files to read.',
  'find-affected-files': 'Find likely affected files for the task/change and call out uncertainty.',
  'plan-implementation': 'Plan the smallest implementation path from the Atlas context.',
  'build-read-order': 'Build an agent read order before implementation.',
  'explain-module': 'Explain the selected module/node and its relationships.',
  'analyze-diff-impact': 'Analyze likely impact from the current diff summary.',
};

export function buildProjectAtlasPrompt(
  variantId: ProjectAtlasPromptVariantId,
  atlas: ProjectAtlas,
  input: BuildProjectAtlasPromptInput = {},
) {
  const variant = PROJECT_ATLAS_PROMPT_VARIANTS.find((item) => item.id === variantId) ?? PROJECT_ATLAS_PROMPT_VARIANTS[0];
  const focusNode = atlas.nodes.find((node) => node.id === input.selectedNodeId);
  const taskFiles = input.task?.targetFiles?.filter(Boolean) ?? [];
  const relevantNodeIds = findRelevantNodeIds(atlas, taskFiles, focusNode);
  const relevantDomains = findRelevantDomains(atlas, relevantNodeIds);
  const relatedTests = findRelatedTests(atlas, relevantNodeIds);
  const readOrder = buildAtlasReadOrder(atlas, {
    nodeIds: relevantNodeIds.length ? [...new Set([...relevantNodeIds, ...relatedTests.map((node) => node.id)])] : undefined,
    limit: input.limit ?? 12,
  });

  return [
    `# Project Atlas Prompt: ${variant.label}`,
    '',
    INSTRUCTIONS[variant.id],
    '',
    'Use Project Atlas as navigation context. Verified facts come from repository scanning; inferred summaries are hints and must be checked against exact files.',
    'Do not edit unrelated modules. Keep explicit targetFiles and implementation maps authoritative over inferred Atlas suggestions.',
    '',
    renderTaskBlock(input.task),
    renderDomains(relevantDomains.length ? relevantDomains : atlas.domains.slice(0, 8)),
    renderReadOrder(readOrder),
    renderRelatedTests(relatedTests),
    focusNode ? renderSelectedNode(atlas, focusNode) : '',
    input.diffSummary ? `## Diff Summary\n${input.diffSummary}` : '',
    '## Out of scope',
    '- Do not broaden the implementation beyond the task/card without naming the reason.',
    '- Do not skip exact file reads before editing.',
  ].filter(Boolean).join('\n\n');
}

function renderTaskBlock(task?: ProjectAtlasPromptTask) {
  if (!task) return '';
  return [
    '## Task Focus',
    task.id ? `- Task: ${task.id}` : '',
    task.title ? `- Title: ${task.title}` : '',
    task.targetFiles?.length ? `- Target files: ${task.targetFiles.join(', ')}` : '- Target files: not provided',
  ].filter(Boolean).join('\n');
}

function renderDomains(domains: AtlasDomain[]) {
  return [
    '## Relevant Domains',
    ...(domains.length
      ? domains.map((domain) => `- ${domain.name} (${domain.origin}): ${domain.summary ?? `${domain.nodeIds.length} nodes`}`)
      : ['- No domains matched.']),
  ].join('\n');
}

function renderReadOrder(items: ReturnType<typeof buildAtlasReadOrder>) {
  return [
    '## Recommended Read Order',
    ...(items.length
      ? items.map((item, index) => `${index + 1}. ${item.path ?? item.label} - ${item.reason}`)
      : ['1. Use repo context bundle, then search for exact target files.']),
  ].join('\n');
}

function renderRelatedTests(nodes: AtlasNode[]) {
  return [
    '## Related Tests',
    ...(nodes.length ? nodes.map((node) => `- ${node.path ?? node.label}`) : ['- No related tests were surfaced by Atlas.']),
  ].join('\n');
}

function renderSelectedNode(atlas: ProjectAtlas, node: AtlasNode) {
  return ['## Selected Node', '```text', buildNodeContext(atlas, node.id), '```'].join('\n');
}

function findRelevantNodeIds(atlas: ProjectAtlas, targetFiles: string[], focusNode?: AtlasNode) {
  const normalizedTargets = targetFiles.map(normalizePath);
  const ids = atlas.nodes
    .filter((node) => {
      const path = normalizePath(node.path || node.label);
      return normalizedTargets.some((target) => path.includes(target) || target.includes(path));
    })
    .map((node) => node.id);
  if (focusNode) ids.push(focusNode.id);
  return [...new Set(ids)];
}

function findRelevantDomains(atlas: ProjectAtlas, nodeIds: string[]) {
  if (nodeIds.length === 0) return [];
  const idSet = new Set(nodeIds);
  return atlas.domains.filter((domain) => domain.nodeIds.some((nodeId) => idSet.has(nodeId)));
}

function findRelatedTests(atlas: ProjectAtlas, relevantNodeIds: string[]) {
  const relevant = new Set(relevantNodeIds);
  return atlas.nodes.filter((node) => {
    if (node.kind !== 'test' && !/\.(test|spec)\.|(^|\/)tests?\//i.test(node.path || node.label)) return false;
    return atlas.edges.some((edge) =>
      (edge.source === node.id && relevant.has(edge.target)) || (edge.target === node.id && relevant.has(edge.source)),
    );
  });
}

function normalizePath(value: string) {
  return value.replace(/\\/g, '/').toLowerCase();
}
