import type { AtlasNode, ProjectAtlas } from '../types.js';

export interface AtlasReadOrderItem {
  id: string;
  label: string;
  kind: AtlasNode['kind'];
  path?: string;
  reason: string;
}

const ORDER_RULES: Array<{ reason: string; matches: (node: AtlasNode) => boolean }> = [
  { reason: 'Shared types/contracts', matches: (node) => !isTestNode(node) && (matchesPath(node, /(^|\/)(types?|contracts?|schema)\./i) || matchesPath(node, /(^|\/)(types?|contracts?|schemas?)(\/|$)/i)) },
  { reason: 'Domain/use-case layer', matches: (node) => !isTestNode(node) && matchesPath(node, /(^|\/)(domain|use-?cases?|interactors?)(\/|$)/i) },
  { reason: 'API/routes/repository layer', matches: (node) => !isTestNode(node) && (node.kind === 'route' || matchesPath(node, /(^|\/)(api|routes?|repositories?|services?|server)(\/|$)/i)) },
  { reason: 'UI/components layer', matches: (node) => !isTestNode(node) && (node.kind === 'component' || matchesPath(node, /(^|\/)(components?|screens?|ui|pages?)(\/|$)/i)) },
  { reason: 'Tests/verification files', matches: isTestNode },
  { reason: 'Related skills/prompts', matches: (node) => matchesPath(node, /(^|\/)(skills?|prompts?)(\/|$)/i) },
];

export function buildAtlasReadOrder(
  atlas: Pick<ProjectAtlas, 'nodes'>,
  input: { nodeIds?: string[]; limit?: number } = {},
): AtlasReadOrderItem[] {
  const allowed = input.nodeIds?.length ? new Set(input.nodeIds) : null;
  const nodes = atlas.nodes.filter((node) => !allowed || allowed.has(node.id));
  const ordered = nodes
    .map((node) => {
      const index = ORDER_RULES.findIndex((rule) => rule.matches(node));
      return {
        node,
        index: index === -1 ? ORDER_RULES.length : index,
        reason: index === -1 ? 'Supporting project file' : ORDER_RULES[index].reason,
      };
    })
    .sort((left, right) => left.index - right.index || stableNodeLabel(left.node).localeCompare(stableNodeLabel(right.node)));

  return ordered.slice(0, input.limit ?? 20).map(({ node, reason }) => ({
    id: node.id,
    label: node.label,
    kind: node.kind,
    path: node.path,
    reason,
  }));
}

function matchesPath(node: AtlasNode, pattern: RegExp) {
  return pattern.test((node.path || node.label).replace(/\\/g, '/'));
}

function isTestNode(node: AtlasNode) {
  return node.kind === 'test' || matchesPath(node, /(^|\/)(tests?|__tests__)(\/|$)|\.(test|spec)\./i);
}

function stableNodeLabel(node: AtlasNode) {
  return node.path || node.label || node.id;
}
