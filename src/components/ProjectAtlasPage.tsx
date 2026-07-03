import { useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Boxes, GitBranch, Layers3, RefreshCw, Search, Settings, ShieldCheck, Waypoints } from 'lucide-react';
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
const NAV_ITEMS = [
  { label: 'Domain Map', icon: Layers3, active: true },
  { label: 'Catalog', icon: Boxes },
  { label: 'Dependencies', icon: GitBranch },
  { label: 'Quality', icon: ShieldCheck },
  { label: 'Reports', icon: BarChart3 },
  { label: 'Settings', icon: Settings },
];

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
          `Summary: ${inspector.description}`,
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
    <section className="flex h-full min-h-0 flex-col bg-[#18120d] text-[#f3eadf]">
      <header className="border-b border-[#584a3b] bg-[#241c15]/95 px-4 py-2.5">
        <div className="flex flex-col gap-3 2xl:flex-row 2xl:items-center 2xl:justify-between">
          <div className="flex min-w-0 items-center gap-4">
            <div>
              <h1 className="flex items-center gap-2 text-lg font-black text-[#f8ead3]">
                <Waypoints size={20} className="text-[#e0a070]" />
                Project Atlas
              </h1>
              <p className="mt-0.5 text-[11px] font-mono font-bold text-[#d6b56d]">
                {data?.status === 'ready' ? `${data.atlas.domains.length} domains · ${data.atlas.edges.length} relationships` : 'Domain-first project intelligence'}
              </p>
            </div>
            <nav className="hidden items-center rounded-lg border border-[#584a3b] bg-[#1e1914] p-1 md:flex">
              {['Overview', 'Domain', 'Structural', 'Diff'].map((tab) => (
                <button key={tab} type="button" className={`rounded-md px-3 py-1.5 text-[11px] font-black ${tab === 'Domain' ? 'bg-[#e0a070] text-[#292119]' : 'text-[#d8c5aa] hover:text-[#f8ead3]'}`}>
                  {tab}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <AtlasSearchBar query={searchQuery} resultCount={resultCount} onQueryChange={setSearchQuery} />
            <div className="flex flex-wrap gap-1.5">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => handleToggleFilter(filter)}
                  className={`h-8 rounded-lg border px-2.5 text-[10px] font-black ${activeFilters.includes(filter) ? 'border-[#e0a070] bg-[#3a2f26] text-[#f7d28a]' : 'border-[#584a3b] bg-[#1e1914] text-[#d8c5aa] hover:text-[#f8ead3]'}`}
                >
                  {filter}
                </button>
              ))}
            </div>
            <button className="h-9 rounded-lg border border-[#584a3b] bg-[#1e1914] px-3 text-[11px] font-extrabold text-[#f3eadf] disabled:opacity-60" type="button" disabled={!projectId || scanState === 'queued' || scanState === 'running'} onClick={handleManualRescan}>
              <RefreshCw size={14} className="mr-1 inline" /> Rescan
            </button>
            <AtlasPromptMenu atlas={data?.atlas ?? null} selectedNode={selectedAtlasNode} />
            <AtlasExportMenu atlas={data?.atlas ?? null} view={exportView} selectedNode={selectedAtlasNode} />
            <AtlasRefreshStatus stale={data?.stale} status={data?.refreshStatus} scanState={scanState} message={data?.message} />
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="hidden w-14 shrink-0 border-r border-[#584a3b] bg-[#241c15] p-2 lg:block">
          <div className="mb-3 flex h-9 items-center justify-center rounded-lg border border-[#584a3b] bg-[#1e1914] text-[#d6b56d]" title="Atlas workspace">
            <Search size={14} className="text-[#e0a070]" />
          </div>
          <div className="space-y-1">
            {NAV_ITEMS.map((item) => (
              <button key={item.label} type="button" title={item.label} className={`flex h-9 w-10 items-center justify-center rounded-lg text-[12px] font-extrabold ${item.active ? 'bg-[#3a2f26] text-[#f8ead3]' : 'text-[#b89b82] hover:bg-[#2b2119] hover:text-[#f3eadf]'}`}>
                <item.icon size={15} className={item.active ? 'text-[#e0a070]' : 'text-[#8c7463]'} />
                <span className="sr-only">{item.label}</span>
              </button>
            ))}
          </div>
        </aside>

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
    <div className="flex h-full min-h-[520px] items-center justify-center bg-[#0c0f13] p-8">
      <div className="max-w-sm rounded-lg border border-[#26303b] bg-[#111820] p-5 text-center shadow-2xl">
        <Activity size={24} className="mx-auto text-[#f0b84d]" />
        <h2 className="mt-3 text-sm font-extrabold text-[#f8ead3]">{title}</h2>
        <p className="mt-2 text-[11px] font-mono leading-relaxed text-[#9da8b5]">{body}</p>
      </div>
    </div>
  );
}
