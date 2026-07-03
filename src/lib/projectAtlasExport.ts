import type { AtlasEdge, AtlasNode, ProjectAtlas } from '../types.js';
import { buildNodeContext } from './projectAtlasViewModel.js';

export interface AtlasGraphExportView {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
}

export function exportAtlasJson(atlas: ProjectAtlas): string {
  return JSON.stringify(stableAtlas(atlas), null, 2);
}

export function renderAtlasMarkdown(atlas: ProjectAtlas, options: { selectedNodeId?: string } = {}): string {
  const lines = [
    '# Project Atlas',
    '',
    `Project: ${atlas.projectId}`,
    `Freshness: ${atlas.freshness.status}`,
    atlas.freshness.generatedAt ? `Generated: ${atlas.freshness.generatedAt}` : undefined,
    '',
    '## Verified facts',
    atlas.summary.verified?.description ? `- ${atlas.summary.verified.description}` : '- No verified project summary yet.',
    '',
    '## Inferred and user-edited notes',
    atlas.summary.inferred?.summary ? `- ${atlas.summary.inferred.summary}` : '- No inferred project summary yet.',
    atlas.summary.userEdited?.notes ? `- ${atlas.summary.userEdited.notes}` : undefined,
    '',
    '## Domains',
    ...[...atlas.domains]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((domain) => `- ${domain.name} (${domain.origin}, ${domain.nodeIds.length} nodes)${domain.summary ? `: ${domain.summary}` : ''}`),
    '',
    '## Key Nodes',
    ...[...atlas.nodes]
      .sort((left, right) => (left.path ?? left.label).localeCompare(right.path ?? right.label))
      .slice(0, 40)
      .map((node) => `- ${node.path ?? node.label} [${node.kind}]${node.verified ? ' verified' : node.inferred ? ' inferred' : node.userEdited ? ' user-edited' : ''}`),
  ].filter((line): line is string => line !== undefined);

  if (options.selectedNodeId) {
    const context = buildNodeContext(atlas, options.selectedNodeId);
    if (context) lines.push('', '## Selected Node Context', '```text', context, '```');
  }

  return `${lines.join('\n')}\n`;
}

export function renderAtlasMermaid(atlas: ProjectAtlas, options: { domainLevel?: boolean } = {}): string {
  const domainLevel = options.domainLevel ?? true;
  if (domainLevel) {
    const domainIds = new Set(atlas.domains.map((domain) => domain.id));
    const lines = [
      'graph TD',
      ...[...atlas.domains]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((domain) => `  ${mermaidId(domain.id)}["${escapeMermaidLabel(domain.name)}"]`),
      ...atlas.edges
        .filter((edge) => edge.kind === 'related' && domainIds.has(edge.source) && domainIds.has(edge.target))
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((edge) => `  ${mermaidId(edge.source)} -. ${edge.kind} .-> ${mermaidId(edge.target)}`),
    ];
    return `${lines.join('\n')}\n`;
  }

  const lines = [
    'graph TD',
    ...[...atlas.nodes]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((node) => `  ${mermaidId(node.id)}["${escapeMermaidLabel(node.label)}"]`),
    ...[...atlas.edges]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((edge) => `  ${mermaidId(edge.source)} -->|${escapeMermaidLabel(edge.kind)}| ${mermaidId(edge.target)}`),
  ];
  return `${lines.join('\n')}\n`;
}

export function renderAtlasSvg(view: AtlasGraphExportView): string {
  const positions = layoutNodes(view.nodes);
  const width = 960;
  const height = 640;
  const edges = view.edges.map((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return '';
    return `<line x1="${source.x}" y1="${source.y}" x2="${target.x}" y2="${target.y}" stroke="#b8a58d" stroke-width="1.4" opacity="0.72" />`;
  }).filter(Boolean);
  const nodes = view.nodes.map((node) => {
    const position = positions.get(node.id) ?? { x: 80, y: 80 };
    const radius = node.kind === 'domain' ? 34 : 25;
    return [
      `<g transform="translate(${position.x} ${position.y})">`,
      `<circle r="${radius}" fill="#fffdfa" stroke="#d8c5aa" stroke-width="1.5" />`,
      `<text y="${radius + 18}" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" font-weight="700" fill="#534135">${escapeXml(truncateLabel(node.label))}</text>`,
      '</g>',
    ].join('');
  });

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    '<rect width="100%" height="100%" fill="#fdfaf5" />',
    ...edges,
    ...nodes,
    '</svg>',
  ].join('');
}

function stableAtlas(atlas: ProjectAtlas): ProjectAtlas {
  return {
    ...atlas,
    nodes: [...atlas.nodes].sort((left, right) => left.id.localeCompare(right.id)),
    edges: [...atlas.edges].sort((left, right) => left.id.localeCompare(right.id)),
    domains: [...atlas.domains].sort((left, right) => left.id.localeCompare(right.id)),
    flows: [...atlas.flows].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function layoutNodes(nodes: AtlasNode[]) {
  const positions = new Map<string, { x: number; y: number }>();
  const radius = Math.max(145, Math.min(250, nodes.length * 17));
  const center = { x: 480, y: 300 };
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(nodes.length, 1) - Math.PI / 2;
    positions.set(node.id, {
      x: Math.round(center.x + Math.cos(angle) * radius),
      y: Math.round(center.y + Math.sin(angle) * radius),
    });
  });
  return positions;
}

function mermaidId(id: string) {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

function escapeMermaidLabel(label: string) {
  return label.replace(/[<>{}"`]/g, '').replace(/\s+/g, ' ').trim();
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateLabel(label: string) {
  return label.length > 24 ? `${label.slice(0, 22)}...` : label;
}
