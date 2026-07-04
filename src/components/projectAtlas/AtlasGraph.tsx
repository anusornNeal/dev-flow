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

interface EdgeRoute {
  path: string;
  label: Point;
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
const GRID_ORIGIN_X = 70;
const GRID_ORIGIN_Y = 70;
const GRID_COLUMN_GAP = 360;
const GRID_ROW_GAP = 240;
const EDGE_PORT_GAP = 32;
const EDGE_ROUTE_RADIUS = 20;
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
  const nodesById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
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
  const edgePorts = useMemo(() => buildEdgePorts(edges, focusSelection, positions), [edges, focusSelection, positions]);
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
        <defs>
          {EDGE_LEGEND_ITEMS.map((style) => (
            <marker key={style.variant} id={`atlas-arrow-${style.variant}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" fill={style.stroke} />
            </marker>
          ))}
        </defs>
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {focusedEdges.map((edge) => {
            const source = positions.get(edge.source);
            const target = positions.get(edge.target);
            if (!source || !target) return null;
            const directlyRelated = Boolean(focusSelection && (edge.source === focusSelection || edge.target === focusSelection));
            const dimmed = canDim && !directlyRelated;
            const visualStyle = edgeVisualStyle(edge);
            const route = edgeRoute(edge, source, target, edgePorts);
            const showLabel = Boolean(!denseGraph && focusSelection && directlyRelated && viewport.zoom > 0.82 && edge.sourceEdgeIds.length <= 3);
            const edgeOpacity = dimmed ? 0.03 : focusSelection && directlyRelated ? 0.9 : 0.14;
            const edgeWidth = dimmed ? 0.6 : focusSelection && directlyRelated ? visualStyle.focusWidth : visualStyle.baseWidth;
            return (
              <g key={edge.id} opacity={edgeOpacity} pointerEvents="none">
                <path
                  d={route.path}
                  fill="none"
                  className="stroke-[#f8efe2] dark:stroke-[#0a0a0a]"
                  strokeWidth={edgeWidth + 7}
                  strokeDasharray={visualStyle.dashArray}
                  strokeLinecap={visualStyle.strokeLinecap}
                />
                <path
                  d={route.path}
                  fill="none"
                  stroke={visualStyle.stroke}
                  strokeWidth={edgeWidth}
                  strokeDasharray={visualStyle.dashArray}
                  strokeLinecap={visualStyle.strokeLinecap}
                  markerEnd={focusSelection && directlyRelated ? `url(#atlas-arrow-${visualStyle.variant})` : undefined}
                />
                {showLabel && (
                  <text x={route.label.x} y={route.label.y - 10} className="fill-[#8a4d0d] text-[10px] font-bold dark:fill-[#f7d28a]">
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
        {nodes.length} domains / {edges.length} dependencies / {focusSelection ? `showing ${focusedEdges.length} focused paths` : 'select a domain to show paths'}
      </div>

      <EdgeLegend focusedEdges={focusedEdges} focusSelection={focusSelection} hiddenFocusedEdgeCount={readableEdges.hiddenFocusedEdgeCount} nodesById={nodesById} />
    </div>
  );
}

function EdgeLegend({ focusedEdges, focusSelection, hiddenFocusedEdgeCount, nodesById }: { focusedEdges: AtlasDomainMapEdge[]; focusSelection: string | null; hiddenFocusedEdgeCount: number; nodesById: Map<string, AtlasDomainMapNode> }) {
  return (
    <div className="absolute bottom-4 right-4 w-72 rounded-lg border border-[#d8c3a6] bg-[#fffaf2]/95 p-3 text-[#5c493c] shadow-xl backdrop-blur dark:border-[rgba(212,165,116,0.18)] dark:bg-[#141414]/92 dark:text-[#f5f0eb]">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d4a574]">Dependency Legend</p>
        <span className="text-[9px] font-black uppercase text-[#8a6d55] dark:text-[#6b5f53]">arrow = target</span>
      </div>
      <div className="mt-2 space-y-1.5">
        {EDGE_LEGEND_ITEMS.map((style) => (
          <div key={style.variant} className="grid grid-cols-[82px_1fr] items-center gap-2">
            <LegendLine style={style} />
            <div className="min-w-0">
              <p className="truncate text-[10px] font-black text-[#2f2923] dark:text-[#f5f0eb]">{style.label}</p>
              <p className="truncate text-[9px] font-bold text-[#7b6554] dark:text-[#a39787]">{style.description}</p>
            </div>
          </div>
        ))}
      </div>
      {focusSelection && focusedEdges.length > 0 && (
        <div className="mt-3 border-t border-[#ead9c2] pt-2 dark:border-[rgba(212,165,116,0.12)]">
          <p className="text-[9px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d4a574]">Reading path</p>
          <div className="mt-1.5 space-y-1">
            {focusedEdges.slice(0, 5).map((edge) => {
              const style = edgeVisualStyle(edge);
              const source = nodesById.get(edge.source)?.title ?? edge.source;
              const target = nodesById.get(edge.target)?.title ?? edge.target;
              return (
                <div key={edge.id} className="grid grid-cols-[10px_1fr] gap-1.5 text-[9px] font-bold text-[#6d5a4d] dark:text-[#d8c5aa]">
                  <span style={{ color: style.stroke }}>-&gt;</span>
                  <span className="truncate"><span className="text-[#3f342b] dark:text-[#f8ead3]">{source}</span> -&gt; {target}</span>
                </div>
              );
            })}
            {focusedEdges.length > 5 && <p className="text-[9px] font-bold text-[#8a6d55] dark:text-[#b89b82]">+{focusedEdges.length - 5} more listed below the fold</p>}
            {hiddenFocusedEdgeCount > 0 && <p className="text-[9px] font-bold text-[#8a6d55] dark:text-[#b89b82]">+{hiddenFocusedEdgeCount} hidden to keep the map readable</p>}
          </div>
        </div>
      )}
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

function buildEdgePorts(edges: AtlasDomainMapEdge[], focusSelection: string | null, positions: Map<string, { x: number; y: number }>) {
  const relevantEdges = focusSelection ? edges.filter((edge) => edge.source === focusSelection || edge.target === focusSelection) : edges;
  const connected = new Map<string, AtlasDomainMapEdge[]>();
  for (const edge of relevantEdges) {
    connected.set(edge.source, [...(connected.get(edge.source) ?? []), edge]);
    connected.set(edge.target, [...(connected.get(edge.target) ?? []), edge]);
  }

  const offsets = new Map<string, number>();
  for (const [nodeId, nodeEdges] of connected) {
    const sorted = [...new Map(nodeEdges.map((edge) => [edge.id, edge])).values()].sort((a, b) => a.id.localeCompare(b.id));
    const count = sorted.length;
    const step = count > 1 ? Math.min(18, (NODE_HEIGHT - 56) / Math.max(1, count - 1)) : 0;
    sorted.forEach((edge, index) => {
      offsets.set(`${nodeId}:${edge.id}`, (index - (count - 1) / 2) * step);
    });
  }
  return offsets;
}

function edgeRoute(
  edge: AtlasDomainMapEdge,
  source: { x: number; y: number },
  target: { x: number; y: number },
  edgePorts: Map<string, number>,
): EdgeRoute {
  const sourceCenter = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT / 2 };
  const targetCenter = { x: target.x + NODE_WIDTH / 2, y: target.y + NODE_HEIGHT / 2 };
  const sourceToRight = targetCenter.x >= sourceCenter.x;
  const sourceSide = sourceToRight ? 'right' : 'left';
  const targetSide = sourceToRight ? 'left' : 'right';
  const sourceDirection = sourceSide === 'right' ? 1 : -1;
  const targetDirection = targetSide === 'right' ? 1 : -1;
  const sourceOffset = edgePorts.get(`${edge.source}:${edge.id}`) ?? 0;
  const targetOffset = edgePorts.get(`${edge.target}:${edge.id}`) ?? 0;
  const start: Point = {
    x: source.x + (sourceSide === 'right' ? NODE_WIDTH : 0),
    y: source.y + NODE_HEIGHT / 2 + sourceOffset,
  };
  const end: Point = {
    x: target.x + (targetSide === 'right' ? NODE_WIDTH : 0),
    y: target.y + NODE_HEIGHT / 2 + targetOffset,
  };
  const sourceExit: Point = { x: start.x + sourceDirection * EDGE_PORT_GAP, y: start.y };
  const targetEntry: Point = { x: end.x + targetDirection * EDGE_PORT_GAP, y: end.y };
  const sourceGrid = gridPosition(source);
  const targetGrid = gridPosition(target);
  const adjacentSameRow = sourceGrid.row === targetGrid.row && Math.abs(sourceGrid.column - targetGrid.column) === 1;
  const laneOffset = stableLaneOffset(edge.id);

  if (adjacentSameRow) {
    const midX = (sourceExit.x + targetEntry.x) / 2 + laneOffset * 0.4;
    const points = [start, sourceExit, { x: midX, y: sourceExit.y }, { x: midX, y: targetEntry.y }, targetEntry, end];
    return { path: roundedPath(points), label: { x: midX, y: (sourceExit.y + targetEntry.y) / 2 } };
  }

  const busY = edgeBusLaneY(source, target, edge.id);
  const points = [start, sourceExit, { x: sourceExit.x, y: busY }, { x: targetEntry.x, y: busY }, targetEntry, end];
  return { path: roundedPath(points), label: { x: (sourceExit.x + targetEntry.x) / 2, y: busY } };
}

function gridPosition(position: { x: number; y: number }) {
  return {
    column: Math.round((position.x - GRID_ORIGIN_X) / GRID_COLUMN_GAP),
    row: Math.round((position.y - GRID_ORIGIN_Y) / GRID_ROW_GAP),
  };
}

function edgeBusLaneY(source: { x: number; y: number }, target: { x: number; y: number }, edgeId: string) {
  const sourceRow = gridPosition(source).row;
  const targetRow = gridPosition(target).row;
  const laneOffset = stableLaneOffset(edgeId);
  if (sourceRow === targetRow) {
    const routeAbove = sourceRow > 0 && stableHash(edgeId) % 2 === 0;
    return routeAbove ? source.y - 46 - laneOffset : source.y + NODE_HEIGHT + 46 + laneOffset;
  }
  return target.y > source.y ? source.y + NODE_HEIGHT + 44 + laneOffset : source.y - 44 - laneOffset;
}

function roundedPath(points: Point[]) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y}`;
  const [start, ...rest] = points;
  let path = `M ${start.x} ${start.y}`;
  for (let index = 0; index < rest.length; index += 1) {
    const current = rest[index];
    const next = rest[index + 1];
    const previous = points[index];
    if (!next) {
      path += ` L ${current.x} ${current.y}`;
      continue;
    }
    const before = moveToward(current, previous, EDGE_ROUTE_RADIUS);
    const after = moveToward(current, next, EDGE_ROUTE_RADIUS);
    path += ` L ${before.x} ${before.y} Q ${current.x} ${current.y} ${after.x} ${after.y}`;
  }
  return path;
}

function moveToward(point: Point, target: Point, distance: number): Point {
  const dx = target.x - point.x;
  const dy = target.y - point.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const amount = Math.min(distance, length / 2) / length;
  return { x: point.x + dx * amount, y: point.y + dy * amount };
}

function stableLaneOffset(value: string) {
  return ((stableHash(value) % 5) - 2) * 7;
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
