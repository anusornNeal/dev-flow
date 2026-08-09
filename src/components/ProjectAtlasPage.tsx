import { useEffect, useMemo, useState } from 'react';
import { Activity } from 'lucide-react';
import type { AtlasNode, ProjectAtlasUiResponse } from '../types.js';
import { AtlasGraph } from './projectAtlas/AtlasGraph.js';
import { AtlasDomainDrilldown } from './projectAtlas/AtlasDomainDrilldown.js';
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
  const [drilldownDomainId, setDrilldownDomainId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeFilters, setActiveFilters] = useState<AtlasDomainFilter[]>([]);
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

  const exportView = useMemo(() => data?.atlas ? buildAtlasGraphViewModel(data.atlas, { layers: DEFAULT_ATLAS_LAYERS }) : null, [data]);
  const domainView = useMemo(() => data?.atlas
    ? buildDomainMapViewModel(data.atlas, { query: searchQuery, activeFilters })
    : null, [data, searchQuery, activeFilters]);
  const inspector = useMemo(() => data?.atlas ? buildDomainInspector(data.atlas, selectedDomainId) : null, [data, selectedDomainId]);
  const drilldownInspector = useMemo(() => data?.atlas ? buildDomainInspector(data.atlas, drilldownDomainId) : null, [data, drilldownDomainId]);
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

  const handleSelectDomain = (domainId: string) => {
    setSelectedDomainId((current) => current === domainId ? null : domainId);
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

  const hasNoResults = !loading && !error && data?.status === 'ready' && domainView && domainView.nodes.length === 0;
  const resultCount = domainView?.matchedNodeIds.length ?? 0;
  const isDrilldownMode = Boolean(drilldownDomainId && drilldownInspector);

  return (
    <section className="flex h-full min-h-0 flex-col bg-[#f6efe6] text-[#241f1a] dark:bg-[#17130f] dark:text-[#f3eadf]">
      <div className="relative z-20 shrink-0 border-b border-[#d8c3a6] bg-[#fffaf2]/96 shadow-[0_10px_32px_rgba(90,62,26,0.10)] backdrop-blur dark:border-[#584a3b]/50 dark:bg-[#292119]/96 dark:shadow-[0_14px_40px_rgba(0,0,0,0.42)]">
        <div role="toolbar" aria-label="Project Atlas controls" className="flex flex-wrap items-center gap-1.5 px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <div className="flex min-w-0 flex-wrap gap-1.5">
              {FILTERS.map((filter) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => handleToggleFilter(filter)}
                  className={`h-8 cursor-pointer rounded-lg border px-2.5 text-[10px] font-black uppercase tracking-wider transition ${activeFilters.includes(filter) ? 'border-[#b7741e] bg-[#fff1d7] text-[#8a4d0d] dark:border-[rgba(245,169,89,0.45)] dark:bg-[rgba(245,169,89,0.18)] dark:text-[#f5a959]' : 'border-[#d8c3a6] bg-[#fffaf2] text-[#685547] hover:border-[#b7741e] hover:text-[#241f1a] dark:border-[#584a3b]/60 dark:bg-[#292119] dark:text-[#d8c5aa] dark:hover:text-[#f8fafc]'}`}
                >
                  {filter}
                </button>
              ))}
            </div>
            <AtlasPromptMenu atlas={data?.atlas ?? null} selectedNode={selectedAtlasNode} />
            <AtlasExportMenu atlas={data?.atlas ?? null} view={exportView} selectedNode={selectedAtlasNode} />
            <AtlasRefreshStatus stale={data?.stale} status={data?.refreshStatus} message={data?.message} />
          </div>
        </div>
        <div className="border-t border-[#ead9c2] bg-[#fff6e8]/88 px-4 py-2 dark:border-[#584a3b]/40 dark:bg-[#1e1914]">
          <AtlasSearchBar query={searchQuery} resultCount={resultCount} onQueryChange={setSearchQuery} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <main className="min-w-0 flex-1">
          {loading && <AtlasCenteredMessage title="Loading Atlas" body="Reading the latest graph snapshot." />}
          {error && <AtlasCenteredMessage title="Atlas unavailable" body={error} />}
          {!loading && !error && (!data || data.status === 'empty' || !domainView) && (
            <AtlasCenteredMessage title="No authored Atlas yet" body="Ask ChatGPT to build or update Project Atlas for this project." />
          )}
          {hasNoResults && <AtlasCenteredMessage title="No matching domains" body="Clear search or filters to return to the full domain map." />}
          {!loading && !error && data?.status === 'ready' && isDrilldownMode && drilldownInspector && (
            <AtlasDomainDrilldown inspector={drilldownInspector} onBack={() => setDrilldownDomainId(null)} />
          )}
          {!loading && !error && data?.status === 'ready' && !isDrilldownMode && domainView && domainView.nodes.length > 0 && (
            <AtlasGraph
              nodes={domainView.nodes}
              edges={domainView.edges}
              selectedNodeId={selectedDomainId}
              highlightedNodeIds={domainView.matchedNodeIds}
              onSelectNode={(node) => handleSelectDomain(node.id)}
            />
          )}
        </main>

        {!isDrilldownMode ? <AtlasNodeInspector inspector={inspector} copied={copiedContext} onCopyContext={handleCopyContext} onOpenDetail={selectedDomainId ? () => setDrilldownDomainId(selectedDomainId) : undefined} /> : null}
      </div>
    </section>
  );
}

function AtlasCenteredMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full min-h-[560px] items-center justify-center bg-[#f6efe6] p-8 dark:bg-[#17130f]">
      <div className="max-w-sm rounded-2xl border border-[#d8c3a6] bg-[#fffaf2] p-6 text-center shadow-xl dark:border-[#584a3b]/60 dark:bg-[#1e1914]">
        <Activity size={24} className="mx-auto text-[#b7741e] dark:text-[#d4a574]" />
        <h2 className="mt-3 text-base font-extrabold text-[#241f1a] dark:text-[#f8fafc]">{title}</h2>
        <p className="mt-2 text-[12px] font-medium leading-relaxed text-[#685547] dark:text-[#d8c5aa]">{body}</p>
      </div>
    </div>
  );
}
