import { useEffect, useMemo, useState } from 'react';
import { Download, RefreshCw, Waypoints } from 'lucide-react';
import type { AtlasNode, ProjectAtlasUiResponse } from '../types.js';
import { AtlasGraph } from './projectAtlas/AtlasGraph.js';
import { AtlasLayerPanel } from './projectAtlas/AtlasLayerPanel.js';
import { AtlasNodeInspector } from './projectAtlas/AtlasNodeInspector.js';
import { AtlasSearchBar } from './projectAtlas/AtlasSearchBar.js';
import { buildAtlasGraphViewModel, buildNodeContext, DEFAULT_ATLAS_LAYERS, searchAtlas, toggleAtlasLayer, type AtlasLayerKey, type AtlasLayers } from '../lib/projectAtlasViewModel.js';

interface ProjectAtlasPageProps {
  projectId: string | null;
}

export function ProjectAtlasPage({ projectId }: ProjectAtlasPageProps) {
  const [data, setData] = useState<ProjectAtlasUiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [layers, setLayers] = useState<AtlasLayers>(DEFAULT_ATLAS_LAYERS);
  const [collapsedDomains, setCollapsedDomains] = useState(true);
  const [selectedNode, setSelectedNode] = useState<AtlasNode | null>(null);
  const [expandedNodeIds, setExpandedNodeIds] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedContext, setCopiedContext] = useState(false);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/projects/${encodeURIComponent(projectId)}/atlas?mode=ui`, { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Atlas load failed with status ${response.status}`);
        return response.json();
      })
      .then((next) => {
        if (!cancelled) setData(next);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const searchResult = useMemo(() => data?.atlas ? searchAtlas(data.atlas, searchQuery) : { query: searchQuery, matchedNodeIds: [] }, [data, searchQuery]);
  const view = useMemo(() => data?.atlas
    ? buildAtlasGraphViewModel(data.atlas, { layers, collapsedDomains, matchedNodeIds: searchResult.matchedNodeIds, expandedNodeIds })
    : null, [data, layers, collapsedDomains, searchResult.matchedNodeIds, expandedNodeIds]);

  const handleToggleLayer = (key: AtlasLayerKey) => setLayers((current) => toggleAtlasLayer(current, key));
  const handleToggleExpandNode = (node: AtlasNode) => {
    setExpandedNodeIds((current) => current.includes(node.id)
      ? current.filter((id) => id !== node.id)
      : [...current, node.id]);
  };
  const handleCopyContext = async () => {
    if (!data?.atlas || !selectedNode) return;
    const context = buildNodeContext(data.atlas, selectedNode.id);
    await navigator.clipboard?.writeText(context);
    setCopiedContext(true);
    window.setTimeout(() => setCopiedContext(false), 1600);
  };

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#faf7f0] dark:bg-[#1e1914]">
      <div className="border-b border-[#e5d4bb] dark:border-[#584a3b] bg-white/80 dark:bg-[#292119]/80 px-5 py-4">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-lg font-extrabold text-[#3c2a1a] dark:text-[#f3eadf]">
              <Waypoints size={19} className="text-[#a46c24] dark:text-[#d6b56d]" />
              Project Atlas
            </h1>
            <p className="mt-0.5 text-[11px] font-mono font-bold text-[#816b5a] dark:text-[#d6b56d]">
              {data?.status === 'ready' ? `${data.atlas.nodes.length} nodes` : 'Graph-first project map'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <AtlasSearchBar query={searchQuery} resultCount={searchResult.matchedNodeIds.length} onQueryChange={setSearchQuery} />
            <button className="h-9 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 text-[11px] font-extrabold text-[#6d5a4d] dark:text-[#f3eadf] disabled:opacity-60" type="button" disabled>
              <RefreshCw size={14} className="mr-1 inline" /> Manual Rescan
            </button>
            <button className="h-9 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#1e1914] px-3 text-[11px] font-extrabold text-[#6d5a4d] dark:text-[#f3eadf] disabled:opacity-60" type="button" disabled>
              <Download size={14} className="mr-1 inline" /> Export
            </button>
            <span className="h-9 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fff7eb] dark:bg-[#3a2f26] px-3 py-2 text-[10px] font-mono font-black uppercase text-[#9a5b13] dark:text-[#f3eadf]">
              {data?.stale ? 'Stale' : data?.atlas?.freshness?.status ?? 'Unknown'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {view && (
          <AtlasLayerPanel
            layers={layers}
            collapsedDomains={collapsedDomains}
            expandedNodeIds={expandedNodeIds}
            domains={view.domains}
            onToggleLayer={handleToggleLayer}
            onToggleCollapsedDomains={() => setCollapsedDomains((current) => !current)}
          />
        )}

        <main className="min-w-0 flex-1">
          {loading && <AtlasCenteredMessage title="Loading Atlas" body="Reading the latest graph snapshot." />}
          {error && <AtlasCenteredMessage title="Atlas unavailable" body={error} />}
          {!loading && !error && (!data || data.status === 'empty' || !view || view.nodes.length === 0) && (
            <AtlasCenteredMessage title="No Atlas generated yet" body="Run Manual Rescan when the scanner workflow is ready for this project." />
          )}
          {!loading && !error && data?.status === 'ready' && view && view.nodes.length > 0 && (
            <AtlasGraph
              nodes={view.nodes}
              edges={view.edges}
              selectedNodeId={selectedNode?.id ?? null}
              highlightedNodeIds={searchResult.matchedNodeIds}
              expandedNodeIds={expandedNodeIds}
              onSelectNode={setSelectedNode}
              onToggleExpandNode={handleToggleExpandNode}
            />
          )}
        </main>

        <AtlasNodeInspector atlas={data?.atlas ?? null} node={selectedNode} copied={copiedContext} onCopyContext={handleCopyContext} />
      </div>
    </section>
  );
}

function AtlasCenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[420px] items-center justify-center p-8">
      <div className="max-w-sm rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#292119] p-5 text-center">
        <h2 className="text-sm font-extrabold text-[#3c2a1a] dark:text-[#f3eadf]">{title}</h2>
        <p className="mt-2 text-[11px] font-mono leading-relaxed text-[#6d5a4d] dark:text-[#d6b56d]">{body}</p>
      </div>
    </div>
  );
}
