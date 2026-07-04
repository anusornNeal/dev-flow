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

const EDGE_LEGEND_ITEMS: EdgeVisualStyle[] = [
  EDGE_VISUAL_STYLES.direct,
  EDGE_VISUAL_STYLES.soft,
  EDGE_VISUAL_STYLES.reference,
  EDGE_VISUAL_STYLES.test,
];

export function AtlasGraph({ nodes, edges, selectedNodeId, highlightedNodeIds = [], onSelectNode }: AtlasGraphProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const positions = useMemo(() => layoutDomainNodes(nodes), [nodes]);
  const bounds = useMemo(() => getGraphBounds(positions), [positions]);
  const relatedIds = useMemo(() => getRelatedNodeIds(edges, selectedNodeId), [edges, selectedNodeId]);
  const highlightedIds = useMemo(() => new Set(highlightedNodeIds), [highlightedNodeIds]);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [viewport, setViewport] = useState<Viewport>({ x: 60, y: 50, zoom: 0.88 });
  const denseGraph = nodes.length > 6 || edges.length > 8 || edges.some((edge) => edge.sourceEdgeIds.length > 3);

  useEffect(() => {
    setViewport(fitViewport(shellRef.current, bounds));
  }, [bounds.width, bounds.height]);

  const focusSelection = selectedNodeId ?? hoveredNodeId;
  const canDim = Boolean(focusSelection);

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
    <div ref={shellRef} className="relative h-full min-h-[620px] overflow-hidden bg-[#f7eddf] dark:bg-[#18120d]">
      <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:radial-gradient(circle_at_1px_1px,rgba(154,91,19,0.18)_1px,transparent_0)] [background-size:22px_22px] dark:[background-image:radial-gradient(circle_at_1px_1px,rgba(224,160,112,0.20)_1px,transparent_0)]" />
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
        <defs>
          {EDGE_LEGEND_ITEMS.map((style) => (
            <marker key={style.variant} id={`atlas-arrow-${style.variant}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={style.stroke} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {edges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const directlyRelated = Boolean(focusSelection && (edge.source === focusSelection || edge.target === focusSelection));
            const showEdge = focusSelection ? directlyRelated || !denseGraph : !denseGraph;
            if (!showEdge) return null;
            const dimmed = canDim && !directlyRelated;
            const visualStyle = edgeVisualStyle(edge);
            const path = edgePath(source, target);
            const showLabel = Boolean(!denseGraph && focusSelection && directlyRelated && viewport.zoom > 0.82 && edge.sourceEdgeIds.length <= 3);
            const edgeOpacity = dimmed ? 0.04 : focusSelection ? 0.72 : 0.18;
            const edgeWidth = dimmed ? 0.6 : focusSelection && directlyRelated ? visualStyle.focusWidth : visualStyle.baseWidth;
            return (
              <g key={edge.id} opacity={edgeOpacity} pointerEvents="none">
                <path
                  d={path}
                  fill="none"
                  stroke={visualStyle.stroke}
                  strokeWidth={edgeWidth}
                  strokeDasharray={visualStyle.dashArray}
                  strokeLinecap={visualStyle.strokeLinecap}
                  markerEnd={focusSelection && directlyRelated ? `url(#atlas-arrow-${visualStyle.variant})` : undefined}
                />
                {showLabel && (
                  <text x={(source.x + target.x) / 2 + NODE_WIDTH / 2} y={(source.y + target.y) / 2 + NODE_HEIGHT / 2 - 10} className="fill-[#8a4d0d] text-[10px] font-bold dark:fill-[#f7d28a]">
                    {edge.label}
                  </text>
                )}
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
              <foreignObject key={node.id} x={position.x} y={position.y} width={NODE_WIDTH} height={NODE_HEIGHT} opacity={dimmed ? 0.34 : 1}>
                <button
                  type="button"
                  data-domain-card
                  onClick={() => onSelectNode(node)}
                  onMouseEnter={() => setHoveredNodeId(node.id)}
                  onMouseLeave={() => setHoveredNodeId(null)}
                  className={`h-full w-full cursor-pointer rounded-lg border bg-[#fffdfa]/95 p-3 text-left shadow-xl transition dark:bg-[#241c15]/95 ${
                    selected
                      ? 'border-[#c9872c] shadow-[#d9a44133]'
                      : highlighted || hovered
                        ? 'border-[#c9872c] shadow-[#d9a44122]'
                        : 'border-[#e5d4bb]'
                  }`}
                >
                  <div className="flex items-start gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-[#e0c7a8] bg-[#fff1d7] text-[#b7741e] dark:border-[#6d5642] dark:bg-[#34281d] dark:text-[#f0b84d]">
                      <DomainIcon category={node.category} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-black text-[#3f342b] dark:text-[#f7ead6]">{node.title}</span>
                      <span className="mt-1 block h-8 overflow-hidden text-[10px] leading-4 text-[#7b6554] dark:text-[#d8c5aa]">{node.description}</span>
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {node.tags.slice(0, viewport.zoom > 0.65 ? 4 : 2).map((tag) => (
                      <span key={tag} className="rounded border border-[#e0c7a8] bg-[#fff7eb] px-1.5 py-0.5 text-[9px] font-black uppercase text-[#9a5b13] dark:border-[#6d5642] dark:bg-[#1b140f] dark:text-[#d6b56d]">
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

      <div className="absolute right-4 top-4 flex overflow-hidden rounded-lg border border-[#e0c7a8] bg-[#fffdfa]/95 shadow-xl dark:border-[#6d5642] dark:bg-[#241c15]/95">
        <GraphButton label="Zoom in" onClick={() => updateZoom(viewport.zoom + 0.12)}><Plus size={15} /></GraphButton>
        <GraphButton label="Zoom out" onClick={() => updateZoom(viewport.zoom - 0.12)}><Minus size={15} /></GraphButton>
        <GraphButton label="Fit view" onClick={() => setViewport(fitViewport(shellRef.current, bounds))}><Focus size={15} /></GraphButton>
        <GraphButton label="Reset view" onClick={() => setViewport({ x: 60, y: 50, zoom: 0.88 })}><RotateCcw size={15} /></GraphButton>
      </div>

      <div className="absolute bottom-4 left-4 rounded-lg border border-[#e0c7a8] bg-[#fffdfa]/95 px-3 py-2 text-[10px] font-bold text-[#5c493c] shadow-xl dark:border-[#6d5642] dark:bg-[#241c15]/95 dark:text-[#f3eadf]">
        {nodes.length} domains · {edges.length} dependencies · {focusSelection ? 'focused dependencies' : denseGraph ? 'select a domain to show dependencies' : `${Math.round(viewport.zoom * 100)}%`}
      </div>

      <EdgeLegend />
    </div>
  );
}

function EdgeLegend() {
  return (
    <div className="absolute bottom-4 right-4 w-72 rounded-lg border border-[#e0c7a8] bg-[#fffdfa]/95 p-3 text-[#5c493c] shadow-xl backdrop-blur dark:border-[#6d5642] dark:bg-[#241c15]/95 dark:text-[#f3eadf]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]">Dependency Legend</p>
        <span className="text-[9px] font-black uppercase text-[#8a6d55] dark:text-[#b89b82]">arrow = target</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {EDGE_LEGEND_ITEMS.map((style) => (
          <div key={style.variant} className="grid grid-cols-[82px_1fr] items-center gap-2">
            <LegendLine style={style} />
            <div className="min-w-0">
              <p className="truncate text-[10px] font-black text-[#3f342b] dark:text-[#f8ead3]">{style.label}</p>
              <p className="truncate text-[9px] font-bold text-[#7b6554] dark:text-[#b89b82]">{style.description}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LegendLine({ style }: { style: EdgeVisualStyle }) {
  return (
    <svg width="82" height="18" viewBox="0 0 82 18" aria-hidden="true">
      <defs>
        <marker id={`legend-arrow-${style.variant}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill={style.stroke} />
        </marker>
      </defs>
      <line
        x1="5"
        y1="9"
        x2="72"
        y2="9"
        stroke={style.stroke}
        strokeWidth={Math.max(2, style.baseWidth)}
        strokeDasharray={style.dashArray}
        strokeLinecap={style.strokeLinecap}
        markerEnd={`url(#legend-arrow-${style.variant})`}
      />
    </svg>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-[#e5d4bb] bg-[#fff7eb] px-1 py-1 dark:border-[#584a3b] dark:bg-[#1b140f]">
      <span className="block text-[11px] font-black text-[#3f342b] dark:text-[#f7ead6]">{value}</span>
      <span className="block text-[8px] font-bold uppercase text-[#8a6d55] dark:text-[#b89b82]">{label}</span>
    </span>
  );
}

function GraphButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-9 w-9 cursor-pointer items-center justify-center border-r border-[#e0c7a8] text-[#b7741e] last:border-r-0 hover:bg-[#fff1d7] dark:border-[#6d5642] dark:text-[#f0b84d] dark:hover:bg-[#3a2f26]">
      {children}
    </button>
  );
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

function edgePath(source: { x: number; y: number }, target: { x: number; y: number }) {
  const sourceCenterX = source.x + NODE_WIDTH / 2;
  const targetCenterX = target.x + NODE_WIDTH / 2;
  const leftToRight = sourceCenterX <= targetCenterX;
  const x1 = source.x + (leftToRight ? NODE_WIDTH : 0);
  const y1 = source.y + NODE_HEIGHT / 2;
  const x2 = target.x + (leftToRight ? 0 : NODE_WIDTH);
  const y2 = target.y + NODE_HEIGHT / 2;
  const direction = leftToRight ? 1 : -1;
  const curve = Math.max(80, Math.abs(x2 - x1) * 0.35);
  return `M ${x1} ${y1} C ${x1 + curve * direction} ${y1}, ${x2 - curve * direction} ${y2}, ${x2} ${y2}`;
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
