import { Box, CircleDot, Database, FileCode, Folder, Route, TestTube2 } from 'lucide-react';
import type { AtlasEdge, AtlasNode } from '../../types.js';

interface AtlasGraphProps {
  nodes: AtlasNode[];
  edges: AtlasEdge[];
  selectedNodeId: string | null;
  highlightedNodeIds?: string[];
  expandedNodeIds?: string[];
  onSelectNode: (node: AtlasNode) => void;
  onToggleExpandNode?: (node: AtlasNode) => void;
}

export function AtlasGraph({ nodes, edges, selectedNodeId, highlightedNodeIds = [], expandedNodeIds = [], onSelectNode, onToggleExpandNode }: AtlasGraphProps) {
  const positions = layoutNodes(nodes);
  const highlightedIds = new Set(highlightedNodeIds);
  const expandedIds = new Set(expandedNodeIds);
  return (
    <div className="h-full min-h-[420px] overflow-auto bg-[#fdfaf5] dark:bg-[#17130f]">
      <svg className="min-w-[900px] min-h-[620px] w-full h-full" viewBox="0 0 960 640" role="img" aria-label="Project Atlas graph">
        <rect width="960" height="640" fill="transparent" />
        {edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          return (
            <line
              key={edge.id}
              x1={source.x}
              y1={source.y}
              x2={target.x}
              y2={target.y}
              stroke={edge.kind === 'related' ? '#a46c24' : '#b8a58d'}
              strokeWidth={edge.kind === 'related' ? 2 : 1.2}
              strokeDasharray={edge.kind === 'related' ? '6 5' : undefined}
              opacity={0.72}
            />
          );
        })}
        {nodes.map((node) => {
          const position = positions.get(node.id) ?? { x: 80, y: 80 };
          const isSelected = selectedNodeId === node.id;
          const isHighlighted = highlightedIds.has(node.id);
          const isExpanded = expandedIds.has(node.id);
          return (
            <g
              key={node.id}
              transform={`translate(${position.x}, ${position.y})`}
              onClick={() => {
                onSelectNode(node);
                if (node.kind === 'domain' || node.kind === 'folder') onToggleExpandNode?.(node);
              }}
              className="cursor-pointer"
            >
              {isHighlighted && <circle r={node.kind === 'domain' ? 42 : 32} fill="none" stroke="#d89745" strokeWidth="3" strokeDasharray="5 4" />}
              <circle r={node.kind === 'domain' ? 34 : 25} fill={isSelected ? '#3c2a1a' : '#fffdfa'} stroke={isExpanded ? '#38b000' : isSelected ? '#e0a070' : '#d8c5aa'} strokeWidth={isSelected || isExpanded ? 3 : 1.5} />
              <foreignObject x="-12" y="-13" width="24" height="24" className="pointer-events-none">
                <div className="flex items-center justify-center text-[#a46c24]">
                  <NodeIcon node={node} />
                </div>
              </foreignObject>
              <text y={node.kind === 'domain' ? 52 : 43} textAnchor="middle" className="fill-[#534135] dark:fill-[#f3eadf] text-[11px] font-bold">
                {truncateLabel(node.label)}
              </text>
              {node.kind === 'domain' && (
                <text y="68" textAnchor="middle" className="fill-[#8a6e5a] dark:fill-[#d6b56d] text-[9px] font-mono">
                  {String(node.metadata?.nodeCount ?? 0)} nodes
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function NodeIcon({ node }: { node: AtlasNode }) {
  if (node.kind === 'domain') return <Box size={18} />;
  if (node.kind === 'folder') return <Folder size={17} />;
  if (node.kind === 'route') return <Route size={17} />;
  if (node.kind === 'database') return <Database size={17} />;
  if (node.kind === 'test') return <TestTube2 size={17} />;
  if (node.kind === 'component') return <CircleDot size={17} />;
  return <FileCode size={17} />;
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

function truncateLabel(label: string) {
  return label.length > 18 ? `${label.slice(0, 16)}...` : label;
}
