import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { Box, Code2, Database, FileText, Focus, Minus, Network, Plus, RotateCcw, Server } from 'lucide-react';
import type { AtlasDomainFilter, AtlasDomainMapEdge, AtlasDomainMapNode } from '../../lib/projectAtlasViewModel.js';

interface AtlasGraphProps {
  nodes: AtlasDomainMapNode[];
  edges: AtlasDomainMapEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds?: string[];
  onSelectNode: (node: AtlasDomainMapNode) => void;
}

interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

interface Point {
  x: number;
  y: number;
}

type EdgeVisualVariant = 'direct' | 'soft' | 'reference' | 'test';

interface EdgeVisualStyle {
  variant: EdgeVisualVariant;
  label: string;
  description: string;
  stroke: string;
  dashArray?: string;
  strokeLinecap?: 'butt' | 'round' | 'square';
  baseWidth: number;
  focusWidth: number;
}

const NODE_WIDTH = 284;
const NODE_HEIGHT = 170;
const MIN_ZOOM = 0.38;
const MAX_ZOOM = 1.72;
const MAX_VISIBLE_FOCUSED_EDGES = 6;

const EDGE_VISUAL_STYLES: Record<EdgeVisualVariant, EdgeVisualStyle> = {
  direct: {
    variant: 'direct',
    label: 'Direct dependency',
    description: 'imports, calls, routes, reads, writes',
    stroke: '#8f5d2a',
    baseWidth: 1.25,
    focusWidth: 2.35,
  },
  soft: {
    variant: 'soft',
    label: 'Inferred / related',
    description: 'soft relationship from heuristics',
    stroke: '#b7741e',
    dashArray: '12 8',
    strokeLinecap: 'butt',
    baseWidth: 1.35,
    focusWidth: 2.2,
  },
  reference: {
    variant: 'reference',
    label: 'Reference / grouping',
    description: 'docs, config, data, ownership',
    stroke: '#c9872c',
    dashArray: '1 8',
    strokeLinecap: 'round',
    baseWidth: 1.7,
    focusWidth: 2.25,
  },
  test: {
    variant: 'test',
    label: 'Test coverage',
    description: 'test relationship',
    stroke: '#7f6a4f',
    dashArray: '7 4 2 4',
    strokeLinecap: 'butt',
    baseWidth: 1.45,
    focusWidth: 2.15,
  },
};

export function AtlasGraph({ nodes, edges, selectedNodeId, highlightedNodeIds = [], onSelectNode }: AtlasGraphProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const positions = useMemo(() => layoutDomainNodes(nodes), [nodes]);
  const groups = useMemo(() => layoutDomainGroups(nodes), [nodes]);
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const bounds = useMemo(() => getGraphBounds(positions), [positions]);
  const relatedIds = useMemo(() => getRelatedNodeIds(edges, selectedNodeId), [edges, selectedNodeId]);
  const highlightedIds = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 50, zoom: 0.82 });

  useEffect(() => {
    setViewport(fitViewport(shellRef.current, bounds));
  }, [bounds.width, bounds.height]);

  const focusSelection = selectedNodeId ?? hoveredNodeId;
  const canDim = Boolean(selectedNodeId);
  const readableEdges = useMemo(() => selectReadableAtlasEdges(edges, focusSelection, MAX_VISIBLE_FOCUSED_EDGES), [edges, focusSelection]);
  const focusedEdges = readableEdges.visibleEdges;

  const updateZoom = (nextZoom: number, anchor?: { x: number; y: number }) => {
    setViewport((current) => {
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (!anchor || zoom === current.zoom) return { ...current, zoom };
      const graphX = (anchor.x - current.x) / current.zoom;
      const graphY = (anchor.y - current.y) / current.zoom;
      return {
        zoom,
        x: anchor.x - graphX * zoom,
        y: anchor.y - graphY * zoom,
      };
    });
  };

  return (
    <div ref={shellRef} className="relative h-full min-h-[680px] overflow-hidden bg-[#f6efe6] dark:bg-[#050914]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_16%,rgba(245,169,89,0.18),transparent_32%),linear-gradient(135deg,rgba(255,255,255,0.44),transparent_42%)] opacity-90 dark:bg-[radial-gradient(circle_at_28%_18%,rgba(245,169,89,0.16),transparent_34%),radial-gradient(circle_at_74%_48%,rgba(59,130,246,0.10),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(154,91,19,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(154,91,19,0.07)_1px,transparent_1px)] [background-size:34px_34px] dark:opacity-35 dark:[background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)]" />
      <svg
        className="relative h-full w-full cursor-grab active:cursor-grabbing"
        role="img"
        aria-label="Project Atlas domain map"
        onWheel={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          updateZoom(viewport.zoom + (event.deltaY > 0 ? -0.08 : 0.08), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }}
        onPointerDown={(event) => {
          if ((event.target as Element).closest('[data-domain-card]')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, viewport };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setViewport({
            ...drag.viewport,
            x: drag.viewport.x + event.clientX - drag.x,
            y: drag.viewport.y + event.clientY - drag.y,
          });
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {groups.map((group) => (
            <g key={group.id} pointerEvents="none">
              <rect x={group.x} y={group.y} width={group.width} height={group.height} rx={22} className="fill-[#fffaf2]/60 stroke-[#ead9c2] dark:fill-[#0f1724]/55 dark:stroke-[rgba(148,163,184,0.18)]" />
              <line x1={group.x} y1={group.y + 18} x2={group.x} y2={group.y + group.height - 18} stroke={categoryColor(group.category)} strokeWidth={4} strokeLinecap="round" />
              <text x={group.x + 24} y={group.y + 30} className="fill-[#9a5b13] text-[13px] font-black uppercase tracking-widest dark:fill-[#f5a959]">{group.label}</text>
              <text x={group.x + group.width - 24} y={group.y + 30} textAnchor="end" className="fill-[#8a6d55] text-[11px] font-bold dark:fill-[#94a3b8]">{group.count} domains</text>
            </g>
          ))}

          {focusedEdges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const directlyRelated = Boolean(focusSelection && (edge.source === focusSelection || edge.target === focusSelection));
            const visualStyle = edgeVisualStyle(edge);
            const path = simpleFocusedEdgePath(edge, source, target);
            const edgeOpacity = focusSelection && directlyRelated ? 0.82 : 0;
            const edgeWidth = focusSelection && directlyRelated ? visualStyle.focusWidth : visualStyle.baseWidth;
            return (
              <g key={edge.id} opacity={edgeOpacity} pointerEvents="none">
                <path
                  d={path}
                  fill="none"
                  className="stroke-[#f6efe6] dark:stroke-[#050914]"
                  strokeWidth={edgeWidth + 6}
                  strokeLinecap="round"
                />
                <path
                  d={path}
                  fill="none"
                  stroke={visualStyle.stroke}
                  strokeWidth={edgeWidth}
                  strokeDasharray={visualStyle.dashArray}
                  strokeLinecap="round"
                />
              </g>
            );
          })}

          {nodes.map((node) => {
            const position = positions.get(node.id) ?? { x: 0, y: 0 };
            const selected = selectedNodeId === node.id;
            const hovered = hoveredNodeId === node.id;
            const related = selected || !focusSelection || relatedIds.has(node.id) || focusSelection === node.id;
            const dimmed = canDim && !related;
            const highlighted = highlightedIds.has(node.id);
            return (
              <foreignObject key={node.id} x={position.x} y={position.y} width={NODE_WIDTH} height={NODE_HEIGHT} opacity={dimmed ? 0.28 : 1}>
                <button
                  type="button"
                  data-domain-card
                  onClick={() => onSelectNode(node)}
                  onMouseEnter={() => setHoveredNodeId(node.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  className={`relative h-full w-full cursor-pointer overflow-hidden rounded-xl border bg-[#fffaf2]/95 p-3 pl-4 text-left shadow-[0_14px_34px_rgba(90,62,26,0.14)] outline-none transition duration-150 hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-[#b7741e] dark:bg-[#0f1724]/96 dark:shadow-[0_14px_38px_rgba(0,0,0,0.44)] ${
                    selected
                      ? 'border-[#b7741e] shadow-[#d9a44140] dark:border-[#f5a959] dark:shadow-[0_0_30px_rgba(245,169,89,0.24)]'
                      : highlighted || hovered
                        ? 'border-[#b7741e] shadow-[#d9a4412e] dark:border-[rgba(245,169,89,0.50)]'
                        : 'border-[#d8c3a6] dark:border-[rgba(148,163,184,0.20)]'
                  }`}
                >
                  <span className="absolute bottom-0 left-0 top-0 w-1.5 rounded-l-xl" style={{ backgroundColor: categoryColor(node.category) }} />
                  <div className="flex items-start gap-3">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[#d8c3a6] bg-[#fff1d7] text-[#b7741e] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#111827] dark:text-[#f5a959]">
                      <DomainIcon category={node.category} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-[15px] font-black leading-5 text-[#241f1a] dark:text-[#f8fafc]">{node.title}</span>
                        <span className="shrink-0 rounded-md border border-[#ead9c2] bg-[#fff8ec] px-1.5 py-0.5 font-mono text-[9px] font-black uppercase text-[#9a6a21] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#0b1220] dark:text-[#f5a959]">{node.status}</span>
                      </span>
                      <span className="mt-1.5 block h-9 overflow-hidden text-[11px] font-medium leading-[17px] text-[#685547] dark:text-[#cbd5e1]">{node.description}</span>
                    </span>
                  </div>
                  <div className="mt-2.5 flex min-h-[22px] flex-wrap gap-1.5">
                    {node.tags.slice(0, viewport.zoom > 0.65 ? 4 : 2).map((tag) => (
                      <span key={tag} className="rounded-md border border-[#d8c3a6] bg-[#fff8ec] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[rgba(245,169,89,0.14)] dark:bg-[#0b1220] dark:text-[#f5a959]">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-2.5 grid grid-cols-4 gap-1.5 text-center">
                    <Metric label="Files" value={node.metrics.files} />
                    <Metric label="Nodes" value={node.metrics.nodes} />
                    <Metric label="Deps" value={node.metrics.dependencies} />
                    <Metric label="Types" value={node.metrics.types} />
                  </div>
                </button>
              </foreignObject>
            );
          })}
        </g>
      </svg>

      <div className="absolute right-4 top-4 flex overflow-hidden rounded-xl border border-[#d8c3a6] bg-[#fffaf2]/95 shadow-xl backdrop-blur dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/92">
        <GraphButton label="Zoom in" onClick={() => updateZoom(viewport.zoom + 0.12)}><Plus size={15} /></GraphButton>
        <GraphButton label="Zoom out" onClick={() => updateZoom(viewport.zoom - 0.12)}><Minus size={15} /></GraphButton>
        <GraphButton label="Fit view" onClick={() => setViewport(fitViewport(shellRef.current, bounds))}><Focus size={15} /></GraphButton>
        <GraphButton label="Reset view" onClick={() => setViewport({ x: 60, y: 50, zoom: 0.88 })}><RotateCcw size={15} /></GraphButton>
      </div>

      <div className="absolute bottom-4 left-4 rounded-xl border border-[#d8c3a6] bg-[#fffaf2]/95 px-4 py-2.5 text-[11px] font-bold text-[#4f4035] shadow-xl backdrop-blur dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/92 dark:text-[#cbd5e1]">
        {nodes.length} domains / {edges.length} relationships / {focusSelection ? `showing ${focusedEdges.length} focused links` : 'select a domain to show links'}
      </div>

      <RelationshipFocusNote
        relationshipGroups={readableEdges.relationshipGroups}
        focusSelection={focusSelection}
        hiddenFocusedEdgeCount={readableEdges.hiddenFocusedEdgeCount}
        nodesById={nodesById}
      />
    </div>
  );
}

function RelationshipFocusNote({
  relationshipGroups,
  focusSelection,
  hiddenFocusedEdgeCount,
  nodesById,
}: {
  relationshipGroups: Array<{ id: string; source: string; target: string; kind: string; label: string; rawRelationshipCount: number }>;
  focusSelection: string | null;
  hiddenFocusedEdgeCount: number;
  nodesById: Map<string, AtlasDomainMapNode>;
}) {
  return (
    <div className="absolute bottom-4 right-4 w-[360px] rounded-2xl border border-[#d8c3a6] bg-[#fffaf2]/95 p-4 text-[#4f4035] shadow-xl backdrop-blur dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/94 dark:text-[#f8fafc]">
      <p className="text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Focus Relationships</p>
      {!focusSelection ? (
        <p className="mt-2 text-[12px] font-semibold leading-relaxed text-[#685547] dark:text-[#cbd5e1]">Select a domain to reveal direct dependencies. The overview stays mostly line-free so the map remains readable.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {relationshipGroups.slice(0, 5).map((group) => {
            const source = nodesById.get(group.source)?.title ?? group.source;
            const target = nodesById.get(group.target)?.title ?? group.target;
              return (
                <div key={group.id} className="rounded-lg border border-[#ead9c2] bg-[#fff8ec] px-3 py-2 text-[11px] font-bold text-[#5c493c] dark:border-[rgba(148,163,184,0.12)] dark:bg-[#0b1220] dark:text-[#dbeafe]">
                  <p className="truncate"><span className="text-[#241f1a] dark:text-[#f8fafc]">{source}</span> -&gt; {target}</p>
                  <p className="mt-0.5 truncate text-[10px] text-[#8a6d55] dark:text-[#94a3b8]">{group.label} / {group.rawRelationshipCount} raw relationships</p>
                </div>
              );
            })}
          {hiddenFocusedEdgeCount > 0 && <p className="text-[10px] font-bold text-[#8a6d55] dark:text-[#94a3b8]">+{hiddenFocusedEdgeCount} hidden to keep the map readable</p>}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-[#d8c3a6] bg-[#fff8ec] px-1 py-1 dark:border-[rgba(148,163,184,0.12)] dark:bg-[#0b1220]">
      <span className="block text-[12px] font-black leading-4 text-[#241f1a] dark:text-[#f8fafc]">{value}</span>
      <span className="block text-[8px] font-bold uppercase leading-3 text-[#8a6d55] dark:text-[#94a3b8]">{label}</span>
    </span>
  );
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-10 w-10 cursor-pointer items-center justify-center border-r border-[#d8c3a6] text-[#b7741e] last:border-r-0 hover:bg-[#fff1d7] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#b7741e] dark:border-[rgba(148,163,184,0.14)] dark:text-[#f5a959] dark:hover:bg-[rgba(245,169,89,0.12)]">
      {children}
    </button>
  );
}

function categoryColor(category: AtlasDomainFilter) {
  if (category === 'CONFIG') return '#5eead4';
  if (category === 'DOCS') return '#7dd3fc';
  if (category === 'INFRA') return '#a78bfa';
  if (category === 'DATA') return '#6ee7b7';
  if (category === 'DOMAIN') return '#b07a8a';
  return '#4a7c9b';
}

function DomainIcon({ category }: { category: AtlasDomainFilter }) {
  if (category === 'CONFIG') return <Server size={18} />;
  if (category === 'DOCS') return <FileText size={18} />;
  if (category === 'INFRA') return <Network size={18} />;
  if (category === 'DATA') return <Database size={18} />;
  if (category === 'DOMAIN') return <Box size={18} />;
  return <Code2 size={18} />;
}

function edgeVisualStyle(edge: AtlasDomainMapEdge): EdgeVisualStyle {
  if (edge.kind === 'related') return EDGE_VISUAL_STYLES.soft;
  if (edge.kind === 'tests') return EDGE_VISUAL_STYLES.test;
  if (edge.kind === 'contains' || edge.kind === 'exports') return EDGE_VISUAL_STYLES.reference;
  return EDGE_VISUAL_STYLES.direct;
}

function simpleFocusedEdgePath(edge: AtlasDomainMapEdge, source: Point, target: Point) {
  const sourceCenter = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT / 2 };
  const targetCenter = { x: target.x + NODE_WIDTH / 2, y: target.y + NODE_HEIGHT / 2 };
  const sourceToRight = targetCenter.x >= sourceCenter.x;
  const start = {
    x: source.x + (sourceToRight ? NODE_WIDTH : 0),
    y: sourceCenter.y,
  };
  const end = {
    x: target.x + (sourceToRight ? 0 : NODE_WIDTH),
    y: targetCenter.y,
  };
  const distance = Math.max(80, Math.abs(end.x - start.x));
  const bend = ((stableHash(edge.id) % 5) - 2) * 10;
  const control = {
    x: start.x + (sourceToRight ? distance : -distance) * 0.5,
    y: (start.y + end.y) / 2 + bend,
  };
  return `M ${start.x} ${start.y} Q ${control.x} ${control.y} ${end.x} ${end.y}`;
}

export function selectReadableAtlasEdges(
  edges: AtlasDomainMapEdge[],
  focusSelection: string | null,
  maxVisibleFocusedEdges = MAX_VISIBLE_FOCUSED_EDGES,
) {
  if (!focusSelection) {
    return {
      visibleEdges: [] as AtlasDomainMapEdge[],
      focusedEdgeCount: 0,
      hiddenFocusedEdgeCount: 0,
      relationshipGroups: [] as Array<{
        id: string;
        source: string;
        target: string;
        kind: AtlasDomainMapEdge['kind'];
        label: string;
        rawRelationshipCount: number;
      }>,
    };
  }

  const focused = edges
    .filter((edge) => edge.source === focusSelection || edge.target === focusSelection)
    .sort((left, right) => left.id.localeCompare(right.id));
  const visibleEdges = focused.slice(0, Math.max(0, maxVisibleFocusedEdges));

  return {
    visibleEdges,
    focusedEdgeCount: focused.length,
    hiddenFocusedEdgeCount: Math.max(0, focused.length - visibleEdges.length),
    relationshipGroups: visibleEdges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      label: edge.label,
      rawRelationshipCount: edge.sourceEdgeIds.length,
    })),
  };
}

function layoutDomainNodes(nodes: AtlasDomainMapNode[]) {
  const positions = new Map<string, { x: number; y: number }>();
  let y = 62;
  for (const group of groupDomainNodes(nodes)) {
    const columns = Math.max(1, Math.min(4, group.nodes.length));
    const rows = Math.ceil(group.nodes.length / columns);
    group.nodes.forEach((node, index) => {
      positions.set(node.id, {
        x: 88 + (index % columns) * (NODE_WIDTH + 42),
        y: y + 48 + Math.floor(index / columns) * (NODE_HEIGHT + 42),
      });
    });
    y += 48 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * 42 + 42;
  }
  return positions;
}

function layoutDomainGroups(nodes: AtlasDomainMapNode[]) {
  let y = 62;
  return groupDomainNodes(nodes).map((group) => {
    const columns = Math.max(1, Math.min(4, group.nodes.length));
    const rows = Math.ceil(group.nodes.length / columns);
    const width = 48 + columns * NODE_WIDTH + Math.max(0, columns - 1) * 42;
    const height = 48 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * 42 + 24;
    const region = { id: group.category, label: categoryGroupLabel(group.category), category: group.category, count: group.nodes.length, x: 64, y, width, height };
    y += 48 + rows * NODE_HEIGHT + Math.max(0, rows - 1) * 42 + 42;
    return region;
  });
}

function groupDomainNodes(nodes: AtlasDomainMapNode[]) {
  const order: AtlasDomainFilter[] = ['DOCS', 'INFRA', 'DATA', 'CONFIG', 'DOMAIN', 'CODE'];
  return order
    .map((category) => ({
      category,
      nodes: nodes.filter((node) => node.category === category).sort((left, right) => left.title.localeCompare(right.title)),
    }))
    .filter((group) => group.nodes.length > 0);
}

function categoryGroupLabel(category: AtlasDomainFilter) {
  if (category === 'DOCS') return 'Docs / Knowledge';
  if (category === 'INFRA') return 'Infra / Tools';
  if (category === 'DATA') return 'Data / UI';
  if (category === 'CONFIG') return 'Config';
  if (category === 'DOMAIN') return 'Domain Logic';
  return 'Code';
}

function stableHash(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function getRelatedNodeIds(edges: AtlasDomainMapEdge[], selectedNodeId: string | null) {
  const ids = new Set<string>();
  if (!selectedNodeId) return ids;
  for (const edge of edges) {
    if (edge.source === selectedNodeId) ids.add(edge.target);
    if (edge.target === selectedNodeId) ids.add(edge.source);
  }
  return ids;
}

function getGraphBounds(positions: Map<string, { x: number; y: number }>) {
  const values = Array.from(positions.values());
  if (values.length === 0) return { x: 0, y: 0, width: 900, height: 560 };
  const minX = Math.min(...values.map((position) => position.x));
  const minY = Math.min(...values.map((position) => position.y));
  const maxX = Math.max(...values.map((position) => position.x + NODE_WIDTH));
  const maxY = Math.max(...values.map((position) => position.y + NODE_HEIGHT));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function fitViewport(element: HTMLDivElement | null, bounds: { x: number; y: number; width: number; height: number }): Viewport {
  const width = element?.clientWidth ?? 960;
  const height = element?.clientHeight ?? 620;
  const zoom = clamp(Math.min((width - 170) / Math.max(bounds.width, 1), (height - 150) / Math.max(bounds.height, 1)), MIN_ZOOM, 0.96);
  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
