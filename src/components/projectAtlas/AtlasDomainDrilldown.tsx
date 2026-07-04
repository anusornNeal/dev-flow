import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, FileCode2, Focus, Minus, Plus, RotateCcw } from 'lucide-react';
import type { AtlasDomainFile, AtlasDomainInspectorViewModel } from '../../lib/projectAtlasViewModel.js';

interface AtlasDomainDrilldownProps {
  inspector: AtlasDomainInspectorViewModel;
  onBack: () => void;
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

interface FileCluster {
  id: string;
  label: string;
  files: AtlasDomainFile[];
}

interface ClusterLayout extends FileCluster {
  x: number;
  y: number;
  width: number;
  height: number;
  visibleFiles: AtlasDomainFile[];
  hiddenCount: number;
  expanded: boolean;
  filePositions: Array<{ file: AtlasDomainFile; x: number; y: number }>;
}

const ROOT_WIDTH = 380;
const ROOT_HEIGHT = 154;
const CLUSTER_WIDTH = 560;
const CLUSTER_HEADER_HEIGHT = 48;
const FILE_WIDTH = 238;
const FILE_HEIGHT = 66;
const FILE_GAP_X = 28;
const FILE_GAP_Y = 22;
const CLUSTER_GAP_X = 92;
const CLUSTER_GAP_Y = 54;
const MAX_COLLAPSED_FILES = 8;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.65;

export function AtlasDomainDrilldown({ inspector, onBack }: AtlasDomainDrilldownProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; viewport: Viewport } | null>(null);
  const [expandedClusterIds, setExpandedClusterIds] = useState<Set<string>>(() => new Set());
  const graph = useMemo(() => buildDrilldownGraph(inspector, expandedClusterIds), [inspector, expandedClusterIds]);
  const [viewport, setViewport] = useState<Viewport>({ x: 80, y: 70, zoom: 0.74 });

  useEffect(() => {
    setExpandedClusterIds(new Set());
  }, [inspector.id]);

  useEffect(() => {
    setViewport(fitViewport(shellRef.current, graph.bounds));
  }, [graph.bounds.width, graph.bounds.height]);

  const updateZoom = (nextZoom: number, anchor?: Point) => {
    setViewport((current) => {
      const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
      if (!anchor || zoom === current.zoom) return { ...current, zoom };
      const graphX = (anchor.x - current.x) / current.zoom;
      const graphY = (anchor.y - current.y) / current.zoom;
      return { zoom, x: anchor.x - graphX * zoom, y: anchor.y - graphY * zoom };
    });
  };

  const handleToggleCluster = (clusterId: string) => {
    setExpandedClusterIds((current) => {
      const next = new Set(current);
      if (next.has(clusterId)) next.delete(clusterId);
      else next.add(clusterId);
      return next;
    });
  };

  return (
    <div ref={shellRef} className="relative h-full min-h-[680px] overflow-hidden bg-[#f6efe6] text-[#241f1a] dark:bg-[#050914] dark:text-[#f8fafc]">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_28%_12%,rgba(245,169,89,0.16),transparent_34%),radial-gradient(circle_at_70%_44%,rgba(59,130,246,0.08),transparent_38%)]" />
      <div className="pointer-events-none absolute inset-0 opacity-25 [background-image:linear-gradient(rgba(154,91,19,0.07)_1px,transparent_1px),linear-gradient(90deg,rgba(154,91,19,0.07)_1px,transparent_1px)] [background-size:34px_34px] dark:opacity-20 dark:[background-image:linear-gradient(rgba(148,163,184,0.12)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.12)_1px,transparent_1px)]" />

      <button
        type="button"
        onClick={onBack}
        className="absolute left-4 top-4 z-20 inline-flex cursor-pointer items-center gap-2 rounded-full border border-[#d8c3a6] bg-[#fffaf2]/94 px-4 py-2 text-[12px] font-black text-[#241f1a] shadow-sm backdrop-blur hover:bg-[#fff1d7] dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/94 dark:text-[#f8fafc] dark:hover:bg-[rgba(245,169,89,0.12)]"
      >
        <ArrowLeft size={14} />
        Project <span className="text-[#8a6d55] dark:text-[#94a3b8]">›</span> <span className="uppercase text-[#9a5b13] dark:text-[#f5a959]">{inspector.name}</span>
        <span className="ml-1 text-[10px] font-bold text-[#8a6d55] dark:text-[#94a3b8]">click to go back</span>
      </button>

      <svg
        className="relative h-full w-full cursor-grab active:cursor-grabbing"
        role="img"
        aria-label={`${inspector.name} domain file graph`}
        onWheel={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          updateZoom(viewport.zoom + (event.deltaY > 0 ? -0.08 : 0.08), { x: event.clientX - rect.left, y: event.clientY - rect.top });
        }}
        onPointerDown={(event) => {
          if ((event.target as Element).closest('[data-drill-node]')) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          dragRef.current = { x: event.clientX, y: event.clientY, viewport };
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag) return;
          setViewport({ ...drag.viewport, x: drag.viewport.x + event.clientX - drag.x, y: drag.viewport.y + event.clientY - drag.y });
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          dragRef.current = null;
        }}
      >
        <g transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.zoom})`}>
          {graph.edges.map((edge) => (
            <g key={edge.id}>
              <path d={edge.path} fill="none" stroke="#f6efe6" strokeWidth={edge.highlight ? 5 : 4} strokeLinecap="round" opacity={0.48} className="dark:stroke-[#050914]" />
              <path d={edge.path} fill="none" stroke={edge.highlight ? '#b7741e' : '#8f5d2a'} strokeWidth={edge.highlight ? 1.35 : 1.05} strokeLinecap="round" opacity={edge.highlight ? 0.68 : 0.42} />
              <text x={edge.labelX} y={edge.labelY} textAnchor="middle" className="fill-[#8a6d55] text-[9px] font-black dark:fill-[#94a3b8]">{edge.label}</text>
            </g>
          ))}

          {graph.clusters.map((cluster) => (
            <g key={cluster.id}>
              <rect x={cluster.x} y={cluster.y} width={cluster.width} height={cluster.height} rx={18} className="fill-[#fffaf2]/58 stroke-[#d8c3a6] dark:fill-[#0f1724]/56 dark:stroke-[rgba(245,169,89,0.18)]" />
              <ClusterHeader cluster={cluster} onToggle={() => handleToggleCluster(cluster.id)} />
              {cluster.filePositions.map(({ file, x, y }) => <FileNode key={file.id} file={file} x={x} y={y} />)}
            </g>
          ))}

          <DomainNode inspector={inspector} x={graph.root.x} y={graph.root.y} />
        </g>
      </svg>

      <div className="absolute right-4 top-4 z-20 flex overflow-hidden rounded-xl border border-[#d8c3a6] bg-[#fffaf2]/95 shadow-xl backdrop-blur dark:border-[rgba(148,163,184,0.18)] dark:bg-[#0f1724]/92">
        <CanvasButton label="Zoom in" onClick={() => updateZoom(viewport.zoom + 0.12)}><Plus size={15} /></CanvasButton>
        <CanvasButton label="Zoom out" onClick={() => updateZoom(viewport.zoom - 0.12)}><Minus size={15} /></CanvasButton>
        <CanvasButton label="Fit view" onClick={() => setViewport(fitViewport(shellRef.current, graph.bounds))}><Focus size={15} /></CanvasButton>
        <CanvasButton label="Reset view" onClick={() => setViewport({ x: 80, y: 70, zoom: 0.74 })}><RotateCcw size={15} /></CanvasButton>
      </div>
    </div>
  );
}

function ClusterHeader({ cluster, onToggle }: { cluster: ClusterLayout; onToggle: () => void }) {
  return (
    <foreignObject x={cluster.x} y={cluster.y} width={cluster.width} height={CLUSTER_HEADER_HEIGHT}>
      <div data-drill-node className="flex h-full items-center justify-between gap-3 px-4 text-left">
        <div className="min-w-0">
          <p className="truncate text-[11px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">{cluster.label}</p>
          <p className="mt-0.5 text-[9px] font-bold text-[#8a6d55] dark:text-[#94a3b8]">showing {cluster.visibleFiles.length} of {cluster.files.length} files</p>
        </div>
        {cluster.hiddenCount > 0 || cluster.expanded ? (
          <button type="button" onClick={onToggle} className="shrink-0 cursor-pointer rounded-md border border-[#ead9c2] bg-[#fff8ec] px-2 py-1 text-[9px] font-black uppercase text-[#8a4d0d] hover:bg-[#fff1d7] dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220] dark:text-[#f5a959] dark:hover:bg-[rgba(245,169,89,0.12)]">
            {cluster.expanded ? 'Collapse' : `View all +${cluster.hiddenCount}`}
          </button>
        ) : null}
      </div>
    </foreignObject>
  );
}

function DomainNode({ inspector, x, y }: { inspector: AtlasDomainInspectorViewModel; x: number; y: number }) {
  return (
    <foreignObject x={x} y={y} width={ROOT_WIDTH} height={ROOT_HEIGHT}>
      <div data-drill-node className="h-full rounded-2xl border border-[#d8c3a6] bg-[#fffaf2]/96 p-4 shadow-[0_20px_52px_rgba(90,62,26,0.18)] dark:border-[rgba(245,169,89,0.22)] dark:bg-[#0f1724]/96 dark:shadow-[0_20px_56px_rgba(0,0,0,0.42)]">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#f5a959]">Domain Detail</p>
            <h2 className="mt-1 truncate text-[20px] font-black leading-tight text-[#241f1a] dark:text-[#f8fafc]">{inspector.name}</h2>
            <p className="mt-1.5 line-clamp-2 text-[11px] font-semibold leading-5 text-[#685547] dark:text-[#cbd5e1]">{inspector.plainSummary}</p>
          </div>
          <span className="shrink-0 rounded-lg border border-[#ead9c2] bg-[#fff8ec] px-2 py-1 text-[9px] font-black uppercase text-[#8a4d0d] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#0b1220] dark:text-[#f5a959]">{inspector.status}</span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-1.5 text-center">
          <Metric label="Files" value={inspector.metrics.files} />
          <Metric label="Nodes" value={inspector.metrics.nodes} />
          <Metric label="Deps" value={inspector.metrics.dependencies} />
          <Metric label="Types" value={inspector.metrics.types} />
        </div>
      </div>
    </foreignObject>
  );
}

function FileNode({ file, x, y }: { file: AtlasDomainFile; x: number; y: number }) {
  return (
    <foreignObject x={x} y={y} width={FILE_WIDTH} height={FILE_HEIGHT}>
      <article data-drill-node className="h-full rounded-xl border border-[#d8c3a6] bg-[#fffaf2]/96 p-2.5 shadow-sm dark:border-[rgba(148,163,184,0.16)] dark:bg-[#0b1220]/94">
        <div className="flex items-start gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#ead9c2] bg-[#fff8ec] text-[#b7741e] dark:border-[rgba(245,169,89,0.18)] dark:bg-[#111827] dark:text-[#f5a959]"><FileCode2 size={14} /></span>
          <span className="min-w-0 flex-1">
            <p className="truncate text-[12px] font-black text-[#241f1a] dark:text-[#f8fafc]">{file.name}</p>
            <p className="mt-1 line-clamp-2 break-all font-mono text-[9px] leading-3 text-[#685547] dark:text-[#cbd5e1]">{file.path}</p>
          </span>
        </div>
      </article>
    </foreignObject>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <span className="rounded-md border border-[#ead9c2] bg-[#fff8ec] px-1 py-1 dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220]">
      <span className="block text-[12px] font-black leading-4 text-[#241f1a] dark:text-[#f8fafc]">{value}</span>
      <span className="block text-[8px] font-bold uppercase leading-3 text-[#8a6d55] dark:text-[#94a3b8]">{label}</span>
    </span>
  );
}

function CanvasButton({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} className="flex h-10 w-10 cursor-pointer items-center justify-center border-r border-[#d8c3a6] text-[#b7741e] last:border-r-0 hover:bg-[#fff1d7] dark:border-[rgba(148,163,184,0.14)] dark:text-[#f5a959] dark:hover:bg-[rgba(245,169,89,0.12)]">
      {children}
    </button>
  );
}

function buildDrilldownGraph(inspector: AtlasDomainInspectorViewModel, expandedClusterIds: Set<string>) {
  const clusters = buildFileClusters(inspector.files);
  const root = { x: 560, y: 86 };
  const columnX = [120, 120 + CLUSTER_WIDTH + CLUSTER_GAP_X];
  const columnY = [330, 330];
  const layouts: ClusterLayout[] = clusters.map((cluster) => {
    const expanded = expandedClusterIds.has(cluster.id);
    const visibleFiles = expanded ? cluster.files : cluster.files.slice(0, MAX_COLLAPSED_FILES);
    const hiddenCount = Math.max(0, cluster.files.length - visibleFiles.length);
    const rows = Math.max(1, Math.ceil(visibleFiles.length / 2));
    const height = CLUSTER_HEADER_HEIGHT + rows * FILE_HEIGHT + Math.max(0, rows - 1) * FILE_GAP_Y + 28;
    const column = columnY[0] <= columnY[1] ? 0 : 1;
    const x = columnX[column];
    const y = columnY[column];
    columnY[column] += height + CLUSTER_GAP_Y;
    const filePositions = visibleFiles.map((file, fileIndex) => ({
      file,
      x: x + 24 + (fileIndex % 2) * (FILE_WIDTH + FILE_GAP_X),
      y: y + CLUSTER_HEADER_HEIGHT + Math.floor(fileIndex / 2) * (FILE_HEIGHT + FILE_GAP_Y),
    }));
    return { ...cluster, x, y, width: CLUSTER_WIDTH, height, visibleFiles, hiddenCount, expanded, filePositions };
  });

  const startIds = new Set(inspector.startHereFiles.map((file) => file.id));
  const edges = layouts.flatMap((cluster) => {
    const clusterCenter = { x: cluster.x + cluster.width / 2, y: cluster.y + 16 };
    const rootEdge = makeEdge(`root-${cluster.id}`, { x: root.x + ROOT_WIDTH / 2, y: root.y + ROOT_HEIGHT }, clusterCenter, 'contains', false);
    const fileEdges = cluster.filePositions.map(({ file, x, y }) => makeEdge(
      `${cluster.id}-${file.id}`,
      clusterCenter,
      { x: x + FILE_WIDTH / 2, y },
      startIds.has(file.id) ? 'start' : 'file',
      startIds.has(file.id),
    ));
    return [rootEdge, ...fileEdges];
  });

  const maxX = Math.max(root.x + ROOT_WIDTH, ...layouts.map((layout) => layout.x + layout.width));
  const maxY = Math.max(root.y + ROOT_HEIGHT, ...layouts.map((layout) => layout.y + layout.height));
  return { root, clusters: layouts, edges, bounds: { x: 80, y: 60, width: maxX - 80 + 120, height: maxY - 60 + 120 } };
}

function makeEdge(id: string, source: Point, target: Point, label: string, highlight: boolean) {
  const midY = (source.y + target.y) / 2;
  const path = `M ${source.x} ${source.y} C ${source.x} ${midY}, ${target.x} ${midY}, ${target.x} ${target.y}`;
  return { id, path, label, highlight, labelX: (source.x + target.x) / 2, labelY: midY - 4 };
}

function buildFileClusters(files: AtlasDomainFile[]): FileCluster[] {
  const groups = new Map<string, AtlasDomainFile[]>();
  files.forEach((file) => {
    const folder = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : 'root';
    groups.set(folder, [...(groups.get(folder) ?? []), file]);
  });
  return [...groups.entries()]
    .sort((left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]))
    .slice(0, 6)
    .map(([id, clusterFiles], index) => ({ id: `${id}-${index}`, label: id, files: clusterFiles.sort((left, right) => left.name.localeCompare(right.name)) }));
}

function fitViewport(element: HTMLDivElement | null, bounds: { x: number; y: number; width: number; height: number }): Viewport {
  const width = element?.clientWidth ?? 960;
  const height = element?.clientHeight ?? 620;
  const zoom = clamp(Math.min((width - 160) / Math.max(bounds.width, 1), (height - 130) / Math.max(bounds.height, 1)), MIN_ZOOM, 0.9);
  return { zoom, x: (width - bounds.width * zoom) / 2 - bounds.x * zoom, y: (height - bounds.height * zoom) / 2 - bounds.y * zoom };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
