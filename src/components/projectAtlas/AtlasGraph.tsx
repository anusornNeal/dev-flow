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

const NODE_WIDTH = 260;
const NODE_HEIGHT = 154;
const MIN_ZOOM = 0.42;
const MAX_ZOOM = 1.7;
const MAX_VISIBLE_FOCUSED_EDGES = 12;

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
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const bounds = useMemo(() => getGraphBounds(positions), [positions]);
  const relatedIds = useMemo(() => getRelatedNodeIds(edges, selectedNodeId), [edges, selectedNodeId]);
  const highlightedIds = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 50, zoom: 0.88 });

  useEffect(() => {
    setViewport(fitViewport(shellRef.current, bounds));
  }, [bounds.width, bounds.height]);

  const focusSelection = selectedNodeId ?? hoveredNodeId;
  const canDim = Boolean(focusSelection);
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
    <div ref={shellRef} className="relative h-full min-h-[620px] overflow-hidden bg-[#f8efe2] dark:bg-[#0a0a0a]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_38%_25%,rgba(212,165,116,0.16),transparent_34%)] opacity-80 dark:bg-[radial-gradient(circle_at_38%_25%,rgba(212,165,116,0.10),transparent_36%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_1px_1px,rgba(154,91,19,0.16)_1px,transparent_0)] [background-size:18px_18px] dark:opacity-50 dark:[background-image:radial-gradient(circle_at_1px_1px,rgba(212,165,116,0.18)_1px,transparent_0)]" />
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
                  className="stroke-[#f8efe2] dark:stroke-[#0a0a0a]"
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
              <foreignObject key={node.id} x={position.x} y={position.y} width={NODE_WIDTH} height={NODE_HEIGHT} opacity={dimmed ? 0.1 : 1}>
                <button
                  type="button"
                  data-domain-card
                  onClick={() => onSelectNode(node)}
                  onMouseEnter={() => setHoveredNodeId(node.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  className={`relative h-full w-full cursor-pointer overflow-hidden rounded-lg border bg-[#fffaf2] p-3 pl-4 text-left shadow-[0_10px_26px_rgba(90,62,26,0.12)] transition dark:bg-[#1a1a1a]/95 dark:shadow-[0_10px_28px_rgba(0,0,0,0.38)] ${
                    selected
                      ? 'border-[#b7741e] shadow-[#d9a44133] dark:border-[#d4a574] dark:shadow-[0_0_22px_rgba(212,165,116,0.18)]'
                      : highlighted || hovered
                        ? 'border-[#b7741e] shadow-[#d9a44122] dark:border-[rgba(212,165,116,0.42)]'
                        : 'border-[#d8c3a6] dark:border-[rgba(212,165,116,0.14)]'
                  }`}
                >
                  <span className="absolute bottom-0 left-0 top-0 w-1 rounded-l-lg" style={{ backgroundColor: categoryColor(node.category) }} />
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#d8c3a6] bg-[#fff1d7] text-[#b7741e] dark:border-[rgba(212,165,116,0.16)] dark:bg-[#111111] dark:text-[#d4a574]">
                      <DomainIcon category={node.category} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate font-serif text-[15px] font-black text-[#2f2923] dark:text-[#f5f0eb]">{node.title}</span>
                        <span className="shrink-0 font-mono text-[9px] font-black text-[#9a6a21] dark:text-[#d4a574]">{node.status}</span>
                      </span>
                      <span className="mt-1 block h-8 overflow-hidden text-[10px] leading-4 text-[#7b6554] dark:text-[#a39787]">{node.description}</span>
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {node.tags.slice(0, viewport.zoom > 0.65 ? 4 : 2).map((tag) => (
                      <span key={tag} className="rounded border border-[#d8c3a6] bg-[#fff8ec] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[rgba(212,165,116,0.14)] dark:bg-[#111111] dark:text-[#d4a574]">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
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

      <div className="absolute right-4 top-4 flex overflow-hidden rounded-lg border border-[#d8c3a6] bg-[#fffaf2]/95 shadow-xl backdrop-blur dark:border-[rgba(212,165,116,0.18)] dark:bg-[#141414]/90">
        <GraphButton label="Zoom in" onClick={() => updateZoom(viewport.zoom + 0.12)}><Plus size={15} /></GraphButton>
        <GraphButton label="Zoom out" onClick={() => updateZoom(viewport.zoom - 0.12)}><Minus size={15} /></GraphButton>
        <GraphButton label="Fit view" onClick={() => setViewport(fitViewport(shellRef.current, bounds))}><Focus size={15} /></GraphButton>
        <GraphButton label="Reset view" onClick={() => setViewport({ x: 60, y: 50, zoom: 0.88 })}><RotateCcw size={15} /></GraphButton>
      </div>

      <div className="absolute bottom-4 left-4 rounded-lg border border-[#d8c3a6] bg-[#fffaf2]/95 px-3 py-2 text-[10px] font-bold text-[#5c493c] shadow-xl backdrop-blur dark:border-[rgba(212,165,116,0.18)] dark:bg-[#141414]/90 dark:text-[#a39787]">
        {nodes.length} domains / {edges.length} relationships / {focusSelection ? `showing ${focusedEdges.length} focused relationships` : 'focus-only edges'}
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
    <div className="absolute bottom-4 right-4 w-72 rounded-lg border border-[#d8c3a6] bg-[#fffaf2]/95 p-3 text-[#5c493c] shadow-xl backdrop-blur dark:border-[rgba(212,165,116,0.18)] dark:bg-[#141414]/92 dark:text-[#f5f0eb]">
      <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d4a574]">Focus Relationships</p>
      {!focusSelection ? (
        <p className="mt-2 text-[10px] font-bold leading-relaxed text-[#7b6554] dark:text-[#a39787]">Focus a domain to reveal direct relationships. Overview stays line-free for readability.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          {relationshipGroups.slice(0, 5).map((group) => {
            const source = nodesById.get(group.source)?.title ?? group.source;
            const target = nodesById.get(group.target)?.title ?? group.target;
              return (
                <div key={group.id} className="text-[9px] font-bold text-[#6d5a4d] dark:text-[#d8c5aa]">
                  <p className="truncate"><span className="text-[#3f342b] dark:text-[#f8ead3]">{source}</span> -&gt; {target}</p>
                  <p className="truncate text-[#8a6d55] dark:text-[#a39787]">{group.label} / {group.rawRelationshipCount} raw relationships</p>
                </div>
              );
            })}
          {hiddenFocusedEdgeCount > 0 && <p className="text-[9px] font-bold text-[#8a6d55] dark:text-[#b89b82]">+{hiddenFocusedEdgeCount} hidden to keep the map readable</p>}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-[#d8c3a6] bg-[#fff8ec] px-1 py-1 dark:border-[rgba(212,165,116,0.12)] dark:bg-[#111111]">
      <span className="block text-[11px] font-black text-[#2f2923] dark:text-[#f5f0eb]">{value}</span>
      <span className="block text-[8px] font-bold uppercase text-[#8a6d55] dark:text-[#6b5f53]">{label}</span>
    </span>
  );
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-9 w-9 cursor-pointer items-center justify-center border-r border-[#d8c3a6] text-[#b7741e] last:border-r-0 hover:bg-[#fff1d7] dark:border-[rgba(212,165,116,0.14)] dark:text-[#d4a574] dark:hover:bg-[rgba(212,165,116,0.12)]">
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
  const columns = nodes.length > 8 ? 4 : nodes.length > 4 ? 3 : 2;
  nodes.forEach((node, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    positions.set(node.id, {
      x: 70 + column * 360 + (row % 2) * 36,
      y: 70 + row * 240,
    });
  });
  return positions;
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
  const zoom = clamp(Math.min((width - 160) / Math.max(bounds.width, 1), (height - 140) / Math.max(bounds.height, 1)), MIN_ZOOM, 1.05);
  return {
    zoom,
    x: (width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (height - bounds.height * zoom) / 2 - bounds.y * zoom,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
