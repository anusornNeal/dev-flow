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
    <section className="flex h-full min-h-0 flex-col bg-[#f6efe6] text-[#241f1a] dark:bg-[#050914] dark:text-[#f8fafc]">
      <header className="shrink-0 border-b border-[#d8c3a6] bg-[#fffaf2]/96 shadow-[0_10px_32px_rgba(90,62,26,0.10)] backdrop-blur dark:border-[rgba(148,163,184,0.14)] dark:bg-[#0b1220]/96 dark:shadow-[0_14px_40px_rgba(0,0,0,0.42)]">
        <div className="flex min-h-[58px] flex-col gap-3 px-4 py-2.5 xl:flex-row xl:items-center">
          <div className="flex min-w-0 shrink-0 items-center gap-3">
            <div>
              <h1 className="flex items-center gap-2 text-xl font-black tracking-tight text-[#241f1a] dark:text-[#f8fafc]">
                <Waypoints size={18} className="text-[#b7741e] dark:text-[#f5a959]" />
                Project Atlas
              </h1>
              <p className="mt-0.5 text-[10px] font-semibold text-[#685547] dark:text-[#cbd5e1]">
                {data?.status === 'ready' ? `${data.atlas.domains.length} domains / ${data.atlas.edges.length} relationships · domain-first overview` : 'Domain-first project intelligence'}
              </p>
            </div>
            <div className="hidden max-w-[280px] rounded-lg border border-[#d8c3a6] bg-[#fff8ec] px-2.5 py-1.5 text-[10px] font-bold leading-relaxed text-[#685547] dark:border-[rgba(148,163,184,0.16)] dark:bg-[#111827] dark:text-[#cbd5e1] md:block">
              Select a domain card to inspect files, dependencies, and copy AI-ready context.
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 xl:justify-end">
            <span className="hidden h-8 items-center rounded-lg border border-[#d8c3a6] bg-[#fff8ec] px-2.5 text-[10px] font-black uppercase tracking-wider text-[#9a5b13] dark:border-[rgba(245,169,89,0.18)] dark:bg-[rgba(245,169,89,0.12)] dark:text-[#f5a959] md:inline-flex">
              Readable Map
            </span>
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => handleToggleFilter(filter)}
                  className={`h-8 cursor-pointer rounded-lg border px-2.5 text-[10px] font-black uppercase tracking-wider transition ${activeFilters.includes(filter) ? 'border-[#b7741e] bg-[#fff1d7] text-[#8a4d0d] dark:border-[rgba(245,169,89,0.45)] dark:bg-[rgba(245,169,89,0.18)] dark:text-[#f5a959]' : 'border-[#d8c3a6] bg-[#fffaf2] text-[#685547] hover:border-[#b7741e] hover:text-[#241f1a] dark:border-[rgba(148,163,184,0.16)] dark:bg-[#111827] dark:text-[#cbd5e1] dark:hover:text-[#f8fafc]'}`}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button className="h-8 cursor-pointer rounded-lg border border-[#d8c3a6] bg-[#fffaf2] px-2.5 text-[11px] font-extrabold text-[#4f4035] transition hover:border-[#b7741e] hover:bg-[#fff1d7] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[rgba(148,163,184,0.16)] dark:bg-[#111827] dark:text-[#f8fafc] dark:hover:bg-[rgba(245,169,89,0.12)]" type="button" disabled={!projectId || scanState === 'queued' || scanState === 'running'} onClick={handleManualRescan}>
              <RefreshCw size={13} className="mr-1 inline" /> Rescan
            </button>
            <AtlasPromptMenu atlas={data?.atlas ?? null} selectedNode={selectedAtlasNode} />
            <AtlasExportMenu atlas={data?.atlas ?? null} view={exportView} selectedNode={selectedAtlasNode} />
            <AtlasRefreshStatus stale={data?.stale} status={data?.refreshStatus} scanState={scanState} message={data?.message} />
          </div>
        </div>
        <div className="border-t border-[#ead9c2] bg-[#fff6e8]/88 px-4 py-2 dark:border-[rgba(148,163,184,0.10)] dark:bg-[#07111f]">
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
              onClearSelection={() => setSelectedDomainId(null)}
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
    <div className="flex h-full min-h-[560px] items-center justify-center bg-[#f6efe6] p-8 dark:bg-[#050914]">
      <div className="max-w-sm rounded-2xl border border-[#d8c3a6] bg-[#fffaf2] p-6 text-center shadow-xl dark:border-[rgba(148,163,184,0.16)] dark:bg-[#0f1724]">
        <Activity size={24} className="mx-auto text-[#b7741e] dark:text-[#d4a574]" />
        <h2 className="mt-3 text-base font-extrabold text-[#241f1a] dark:text-[#f8fafc]">{title}</h2>
        <p className="mt-2 text-[12px] font-medium leading-relaxed text-[#685547] dark:text-[#cbd5e1]">{body}</p>
      </div>
    </div>
  );
}
