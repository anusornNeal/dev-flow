import { useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Waypoints } from 'lucide-react';
import type { AtlasNode, ProjectAtlasUiResponse } from '../types.js';
import { AtlasGraph } from './projectAtlas/AtlasGraph.js';
import { AtlasExportMenu } from './projectAtlas/AtlasExportMenu.js';
import { AtlasPromptMenu } from './projectAtlas/AtlasPromptMenu.js';
import { AtlasNodeInspector } from './projectAtlas/AtlasNodeInspector.js';
import { AtlasRefreshStatus } from './projectAtlas/AtlasRefreshStatus.js';
import { AtlasSearchBar } from './projectAtlas/AtlasSearchBar.js';
import {
  buildAtlasGraphViewModel,
  buildDomainInspector,
  buildDomainMapViewModel,
  buildNodeContext,
  DEFAULT_ATLAS_LAYERS,
  type AtlasDomainFilter,
} from '../lib/projectAtlasViewModel.js';

interface ProjectAtlasPageProps {
  projectId: string | null;
}

const FILTERS: AtlasDomainFilter[] = ['CODE', 'CONFIG', 'DOCS', 'INFRA', 'DATA', 'DOMAIN'];

export function ProjectAtlasPage({ projectId }: ProjectAtlasPageProps) {
  const [data, setData] = useState<ProjectAtlasUiResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedDomainId, setSelectedDomainId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<AtlasDomainFilter[]>([]);
  const [copiedContext, setCopiedContext] = useState(false);
  const [scanState, setScanState] = useState<'idle' | 'queued' | 'running' | 'succeeded' | 'failed'>('idle');

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

  const exportView = useMemo(() => data?.atlas ? buildAtlasGraphViewModel(data.atlas, { layers: DEFAULT_ATLAS_LAYERS }) : null, [data]);
  const domainView = useMemo(() => data?.atlas
    ? buildDomainMapViewModel(data.atlas, { query: searchQuery, activeFilters })
    : null, [data, searchQuery, activeFilters]);
  const inspector = useMemo(() => data?.atlas ? buildDomainInspector(data.atlas, selectedDomainId) : null, [data, selectedDomainId]);
  const selectedAtlasNode = useMemo(() => {
    if (!data?.atlas || !selectedDomainId) return null;
    const existing = data.atlas.nodes.find((node) => node.id === selectedDomainId);
    if (existing) return existing;
    const domain = data.atlas.domains.find((candidate) => candidate.id === selectedDomainId);
    if (!domain) return null;
    return {
      id: domain.id,
      label: domain.name,
      kind: 'domain',
      inferred: domain.summary ? { source: 'inferred', summary: domain.summary } : undefined,
      metadata: { origin: domain.origin },
    } satisfies AtlasNode;
  }, [data, selectedDomainId]);

  useEffect(() => {
    if (!domainView || !selectedDomainId) return;
    if (!domainView.nodes.some((node) => node.id === selectedDomainId)) {
      setSelectedDomainId(domainView.nodes[0]?.id ?? null);
    }
  }, [domainView, selectedDomainId]);

  const handleToggleFilter = (filter: AtlasDomainFilter) => {
    setActiveFilters((current) => current.includes(filter) ? current.filter((item) => item !== filter) : [...current, filter]);
  };

  const handleCopyContext = async () => {
    if (!data?.atlas || !selectedDomainId) return;
    const nodeContext = buildNodeContext(data.atlas, selectedDomainId);
    const domainContext = inspector
      ? [
          `Domain: ${inspector.name}`,
          `Status: ${inspector.status}`,
          `Summary: ${inspector.plainSummary}`,
          `Metrics: ${inspector.metrics.files} files, ${inspector.metrics.nodes} nodes, ${inspector.metrics.dependencies} dependencies`,
          inspector.technologies.length ? `Technologies: ${inspector.technologies.join(', ')}` : undefined,
          inspector.files.length ? `Files:\n${inspector.files.map((file) => `- ${file.path}`).join('\n')}` : undefined,
        ].filter(Boolean).join('\n')
      : '';
    await navigator.clipboard?.writeText(nodeContext || domainContext);
    setCopiedContext(true);
    window.setTimeout(() => setCopiedContext(false), 1600);
  };

  const handleManualRescan = async () => {
    if (!projectId) return;
    setScanState('queued');
    try {
      const response = await fetch('/api/project-atlas/rescan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectId }),
      });
      if (!response.ok) throw new Error(`Atlas rescan failed with status ${response.status}`);
      const result = await response.json();
      setScanState(result.jobId ? 'queued' : 'succeeded');
    } catch {
      setScanState('failed');
    }
  };

  const hasNoResults = !loading && !error && data?.status === 'ready' && domainView && domainView.nodes.length === 0;
  const resultCount = domainView?.matchedNodeIds.length ?? 0;

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f8efe2] text-[#2f2923] dark:bg-[#0a0a0a] dark:text-[#f5f0eb]">
      <header className="shrink-0 border-b border-[#d8c3a6] bg-[#fffaf2]/95 shadow-sm dark:border-[rgba(212,165,116,0.12)] dark:bg-[#111111]/95">
        <div className="flex min-h-[56px] flex-col gap-3 px-4 py-3 xl:flex-row xl:items-center">
          <div className="flex min-w-0 shrink-0 items-center gap-4">
            <div>
              <h1 className="flex items-center gap-2 font-serif text-2xl font-black tracking-wide text-[#2f2923] dark:text-[#f5f0eb]">
                <Waypoints size={20} className="text-[#b7741e] dark:text-[#d4a574]" />
                Project Atlas
              </h1>
              <p className="mt-0.5 text-[10px] font-mono font-bold uppercase tracking-widest text-[#9a6a21] dark:text-[#a39787]">
                {data?.status === 'ready' ? `${data.atlas.domains.length} domains / ${data.atlas.edges.length} relationships` : 'Domain-first project intelligence'}
              </p>
            </div>
            <div className="hidden items-center rounded-lg bg-[#efe2cf] p-0.5 dark:bg-[#1a1a1a] md:flex">
              <span className="rounded-md bg-[#fff8ec] px-3 py-1 text-[11px] font-black text-[#9a5b13] shadow-sm dark:bg-[rgba(212,165,116,0.16)] dark:text-[#d4a574]">Overview</span>
              <span className="px-3 py-1 text-[11px] font-bold text-[#8a6d55] dark:text-[#6b5f53]">Learn</span>
              <span className="px-3 py-1 text-[11px] font-bold text-[#8a6d55] dark:text-[#6b5f53]">Deep Dive</span>
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 xl:justify-end">
            <span className="hidden rounded-lg border border-[#d8c3a6] bg-[#fff8ec] px-3 py-1.5 text-[10px] font-black uppercase tracking-wider text-[#9a5b13] dark:border-[rgba(212,165,116,0.18)] dark:bg-[rgba(212,165,116,0.16)] dark:text-[#d4a574] md:inline-flex">
              Layers ON
            </span>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => handleToggleFilter(filter)}
                  className={`h-8 cursor-pointer rounded-lg border px-2.5 text-[10px] font-black uppercase tracking-wider transition ${activeFilters.includes(filter) ? 'border-[#b7741e] bg-[#fff1d7] text-[#8a4d0d] dark:border-[rgba(212,165,116,0.45)] dark:bg-[rgba(212,165,116,0.18)] dark:text-[#d4a574]' : 'border-[#d8c3a6] bg-[#fffaf2] text-[#7b6554] hover:border-[#b7741e] hover:text-[#2f2923] dark:border-[rgba(212,165,116,0.16)] dark:bg-[#1a1a1a] dark:text-[#a39787] dark:hover:text-[#f5f0eb]'}`}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button className="h-9 cursor-pointer rounded-lg border border-[#d8c3a6] bg-[#fffaf2] px-3 text-[11px] font-extrabold text-[#5c493c] transition hover:border-[#b7741e] hover:bg-[#fff1d7] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[rgba(212,165,116,0.16)] dark:bg-[#1a1a1a] dark:text-[#f5f0eb] dark:hover:bg-[rgba(212,165,116,0.12)]" type="button" disabled={!projectId || scanState === 'queued' || scanState === 'running'} onClick={handleManualRescan}>
              <RefreshCw size={14} className="mr-1 inline" /> Rescan
            </button>
            <AtlasPromptMenu atlas={data?.atlas ?? null} selectedNode={selectedAtlasNode} />
            <AtlasExportMenu atlas={data?.atlas ?? null} view={exportView} selectedNode={selectedAtlasNode} />
            <AtlasRefreshStatus stale={data?.stale} status={data?.refreshStatus} scanState={scanState} message={data?.message} />
          </div>
        </div>
        <div className="border-t border-[#ead9c2] bg-[#fff6e8]/85 px-4 py-2 dark:border-[rgba(212,165,116,0.08)] dark:bg-[#0d0d0d]">
          <AtlasSearchBar query={searchQuery} resultCount={resultCount} onQueryChange={setSearchQuery} />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {loading && <AtlasCenteredMessage title="Loading Atlas" body="Reading the latest graph snapshot." />}
          {error && <AtlasCenteredMessage title="Atlas unavailable" body={error} />}
          {!loading && !error && (!data || data.status === 'empty' || !domainView) && (
            <AtlasCenteredMessage title="No Atlas generated yet" body="Run Manual Rescan when the scanner workflow is ready for this project." />
          )}
          {hasNoResults && <AtlasCenteredMessage title="No matching domains" body="Clear search or filters to return to the full domain map." />}
          {!loading && !error && data?.status === 'ready' && domainView && domainView.nodes.length > 0 && (
            <AtlasGraph
              nodes={domainView.nodes}
              edges={domainView.edges}
              selectedNodeId={selectedDomainId}
              highlightedNodeIds={domainView.matchedNodeIds}
              onSelectNode={(node) => setSelectedDomainId(node.id)}
            />
          )}
        </main>

        <AtlasNodeInspector inspector={inspector} copied={copiedContext} onCopyContext={handleCopyContext} />
      </div>
    </section>
  );
}

function AtlasCenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[520px] items-center justify-center bg-[#f8efe2] p-8 dark:bg-[#0a0a0a]">
      <div className="max-w-sm rounded-lg border border-[#d8c3a6] bg-[#fffaf2] p-5 text-center shadow-xl dark:border-[rgba(212,165,116,0.16)] dark:bg-[#141414]">
        <Activity size={24} className="mx-auto text-[#b7741e] dark:text-[#d4a574]" />
        <h2 className="mt-3 text-sm font-extrabold text-[#2f2923] dark:text-[#f5f0eb]">{title}</h2>
        <p className="mt-2 text-[11px] font-mono leading-relaxed text-[#7b6554] dark:text-[#a39787]">{body}</p>
      </div>
    </div>
  );
}
