import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  Clock3,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserRoundCog,
} from 'lucide-react';
import { getAgentOfficeProjection, type AgentOfficeProjection, type AgentOfficeQueueState } from '../client/apiClient';

const REFRESH_INTERVAL_MS = 5_000;
const STALE_SNAPSHOT_MS = 15_000;

const QUEUE_META: Record<AgentOfficeQueueState, { label: string; description: string }> = {
  ready: { label: 'Ready', description: 'Runnable work' },
  execution: { label: 'Execution', description: 'Work in progress' },
  attention: { label: 'Attention', description: 'Reasoning or handoff needed' },
  blocked: { label: 'Blocked', description: 'Waiting on a dependency or recovery' },
};

const PIPELINE_LABELS: Record<string, string> = {
  'waiting-verification': 'Waiting verify',
  verifying: 'Verifying',
  integrating: 'Integrating',
  finalizing: 'Finalizing',
  cleanup: 'Cleanup',
};

export function formatActivityAge(ageMs: number | null | undefined) {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'age unknown';
  const seconds = Math.max(0, Math.floor(ageMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function isAgentOfficeSnapshotStale(generatedAt: string | null | undefined, nowMs = Date.now()) {
  const generatedAtMs = Date.parse(String(generatedAt || ''));
  return !Number.isFinite(generatedAtMs) || nowMs - generatedAtMs > STALE_SNAPSHOT_MS;
}

function sourceLabel(source: string) {
  if (source === 'devflow-managed') return 'DevFlow managed';
  if (source === 'worker-native') return 'Local native';
  return 'Legacy agent';
}

function statusDotClass(indicator: string | null, stale: boolean) {
  if (stale || indicator === 'disconnected') return 'bg-[#c45d3d]';
  if (indicator === 'blocked') return 'bg-[#c45d3d]';
  if (indicator === 'attention') return 'bg-[#d89745]';
  return 'bg-[#55a05a]';
}

interface AgentOfficePageProps {
  projectId: string;
  onOpenTask: (taskId: string) => void | Promise<void>;
  initialSnapshot?: AgentOfficeProjection | null;
  initialError?: string | null;
  disableAutoLoad?: boolean;
  nowMs?: number;
}

export default function AgentOfficePage({
  projectId,
  onOpenTask,
  initialSnapshot = null,
  initialError = null,
  disableAutoLoad = false,
  nowMs,
}: AgentOfficePageProps) {
  const [snapshot, setSnapshot] = useState<AgentOfficeProjection | null>(initialSnapshot);
  const [loading, setLoading] = useState(!initialSnapshot && !disableAutoLoad);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const load = useCallback(async (background = false) => {
    if (!projectId) {
      setSnapshot(null);
      setLoading(false);
      setRefreshing(false);
      setError(null);
      return;
    }
    if (background) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await getAgentOfficeProjection(projectId, 20);
      setSnapshot(next);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Agent Office could not refresh.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [projectId]);

  useEffect(() => {
    if (disableAutoLoad) return undefined;
    void load(false);
    const intervalId = window.setInterval(() => void load(true), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [disableAutoLoad, load]);

  const pipelineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of snapshot?.pipeline.items || []) counts.set(row.stage, (counts.get(row.stage) || 0) + 1);
    return counts;
  }, [snapshot]);

  const staleSnapshot = snapshot ? isAgentOfficeSnapshotStale(snapshot.generatedAt, nowMs ?? Date.now()) : false;
  const queueTotal = snapshot
    ? Object.values(snapshot.queue.counts).reduce((sum, count) => sum + count, 0)
    : 0;
  const empty = Boolean(snapshot) && snapshot!.workers.total === 0 && snapshot!.pipeline.total === 0 && queueTotal === 0;

  if (!projectId) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-md rounded-2xl border border-[#e5d4bb] bg-[#fffdfa] p-6 text-center dark:border-[#584a3b] dark:bg-[#292119]">
          <Bot className="mx-auto mb-3 text-[#d89745]" size={28} />
          <h2 className="text-sm font-extrabold">Choose a project to open Agent Office</h2>
          <p className="mt-2 text-xs text-[#816b5a] dark:text-[#d6b56d]">Monitoring is always scoped to one project.</p>
        </div>
      </div>
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center gap-3 text-xs font-bold text-[#8c7463] dark:text-[#d6b56d]">
        <Loader2 className="animate-spin" size={18} /> Loading Agent Office…
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-2xl border border-[#e6a994] bg-[#fff5f0] p-6 dark:border-[#70483d] dark:bg-[#32221d]">
          <div className="flex items-center gap-2 text-sm font-extrabold text-[#a33f25] dark:text-[#f0b29f]"><ShieldAlert size={18} /> Agent Office unavailable</div>
          <p className="mt-2 text-xs text-[#805446] dark:text-[#e7c3b8]">{error}</p>
          <button type="button" onClick={() => void load(false)} className="mt-4 inline-flex cursor-pointer items-center gap-2 rounded-xl border border-[#d8c5aa] bg-white px-3 py-2 text-xs font-bold text-[#714a1a] hover:bg-[#fff7ec] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f3eadf]">
            <RefreshCw size={14} /> Refresh read
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#faf7f0] p-4 md:p-6 dark:bg-[#1e1914]">
      <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
        <section className="rounded-2xl border border-[#e5d4bb] bg-white/85 px-5 py-4 shadow-sm dark:border-[#584a3b] dark:bg-[#292119]">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <Activity size={18} className="text-[#d89745]" />
                <h1 className="text-lg font-extrabold tracking-tight text-[#3c2a1a] dark:text-[#f3eadf]">Agent Office</h1>
                <span className="rounded-full border border-[#e4cfb0] bg-[#fff7eb] px-2 py-0.5 text-[9px] font-black uppercase tracking-wider text-[#8d6533] dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#d6b56d]">Monitoring only</span>
              </div>
              <p className="mt-1 text-[11px] font-mono text-[#816b5a] dark:text-[#d6b56d]">Canonical workers, pipeline and queue state • project {projectId}</p>
            </div>
            <div className="flex items-center gap-2 text-[10px] font-mono text-[#8c7463] dark:text-[#d6b56d]">
              {snapshot && <span>Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}</span>}
              <button type="button" onClick={() => void load(true)} disabled={refreshing} className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-[#d8c5aa] bg-[#fff7ec] px-2.5 py-1.5 font-bold text-[#714a1a] hover:bg-[#ffeace] disabled:cursor-default disabled:opacity-60 dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#f3eadf]">
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
              </button>
            </div>
          </div>
        </section>

        {(staleSnapshot || error) && (
          <div className="flex items-start gap-2 rounded-2xl border border-[#e5bb78] bg-[#fff7e8] px-4 py-3 text-xs text-[#81591e] dark:border-[#695232] dark:bg-[#30271c] dark:text-[#e8c98c]">
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
            <div><strong>{staleSnapshot ? 'Snapshot is stale.' : 'Refresh failed.'}</strong> {error ? `Showing the last successful snapshot. ${error}` : 'The page will keep retrying its read-only refresh.'}</div>
          </div>
        )}

        {empty ? (
          <div className="rounded-2xl border border-dashed border-[#d8c5aa] bg-[#fffdfa] px-6 py-12 text-center dark:border-[#584a3b] dark:bg-[#292119]">
            <CheckCircle2 className="mx-auto text-[#68a66b]" size={28} />
            <h2 className="mt-3 text-sm font-extrabold">Agent Office is quiet</h2>
            <p className="mt-1 text-xs text-[#816b5a] dark:text-[#d6b56d]">No active workers, pipeline tails, queue work or attention right now.</p>
          </div>
        ) : snapshot ? (
          <>
            <section className="grid gap-4 xl:grid-cols-[1.3fr_1fr]">
              <div className="rounded-2xl border border-[#e5d4bb] bg-[#fffdfa] p-4 dark:border-[#584a3b] dark:bg-[#292119]">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2"><UserRoundCog size={16} className="text-[#d89745]" /><h2 className="text-sm font-extrabold">Active Agents</h2></div>
                  <span className="rounded-full bg-[#f2e5d2] px-2 py-1 text-[10px] font-black dark:bg-[#3a2f26]">{snapshot.workers.total}</span>
                </div>
                <div className="space-y-2">
                  {snapshot.workers.items.length === 0 && <p className="rounded-xl border border-dashed border-[#e5d4bb] p-4 text-xs text-[#8c7463] dark:border-[#584a3b] dark:text-[#d6b56d]">No active reasoning workers.</p>}
                  {snapshot.workers.items.map((worker) => (
                    <button key={worker.taskId} type="button" onClick={() => void onOpenTask(worker.taskId)} className="group flex w-full cursor-pointer items-start gap-3 rounded-xl border border-[#eadbc6] bg-white px-3.5 py-3 text-left transition hover:border-[#d8a15f] hover:bg-[#fff9f1] dark:border-[#584a3b] dark:bg-[#211b16] dark:hover:bg-[#30271f]">
                      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(worker.indicator, worker.stale)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-xs font-extrabold">{worker.ownerLabel}</span>
                          <span className="rounded-full border border-[#e1d1bc] px-1.5 py-0.5 text-[9px] font-bold text-[#816b5a] dark:border-[#584a3b] dark:text-[#d6b56d]">{sourceLabel(worker.source)}</span>
                          {worker.ownerKind && <span className="rounded-full border border-[#e1d1bc] px-1.5 py-0.5 text-[9px] font-mono font-bold text-[#816b5a] dark:border-[#584a3b] dark:text-[#d6b56d]">{worker.ownerKind}</span>}
                          {(worker.stale || worker.indicator) && <span className="text-[9px] font-black uppercase tracking-wide text-[#b65036]">{worker.stale ? 'Disconnected' : worker.indicator}</span>}
                        </div>
                        <div className="mt-1 truncate text-[11px] font-bold text-[#584638] dark:text-[#f3eadf]">{worker.displayId || worker.taskId} · {worker.title}</div>
                        <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[10px] font-mono text-[#8c7463] dark:text-[#d6b56d]"><span>{worker.action}</span><span>{worker.phaseLabel}</span><span className="inline-flex items-center gap-1"><Clock3 size={10} /> {formatActivityAge(worker.ageMs)}</span></div>
                      </div>
                    </button>
                  ))}
                  {snapshot.workers.truncated && <p className="px-1 text-[10px] font-mono text-[#8c7463] dark:text-[#d6b56d]">More workers exist beyond this bounded view.</p>}
                </div>
              </div>

              <div className="rounded-2xl border border-[#e5d4bb] bg-[#fffdfa] p-4 dark:border-[#584a3b] dark:bg-[#292119]">
                <div className="mb-3 flex items-center justify-between">
                  <div className="flex items-center gap-2"><GitMerge size={16} className="text-[#d89745]" /><h2 className="text-sm font-extrabold">DevFlow Pipeline</h2></div>
                  <span className="rounded-full bg-[#f2e5d2] px-2 py-1 text-[10px] font-black dark:bg-[#3a2f26]">{snapshot.pipeline.total}</span>
                </div>
                <div className="mb-3 flex flex-wrap gap-1.5">
                  {Object.entries(PIPELINE_LABELS).map(([stage, label]) => (
                    <span key={stage} className="rounded-lg border border-[#e5d4bb] bg-white px-2 py-1 text-[9px] font-bold dark:border-[#584a3b] dark:bg-[#211b16]">{label} {pipelineCounts.get(stage) || 0}</span>
                  ))}
                </div>
                <div className="space-y-2">
                  {snapshot.pipeline.items.length === 0 && <p className="rounded-xl border border-dashed border-[#e5d4bb] p-4 text-xs text-[#8c7463] dark:border-[#584a3b] dark:text-[#d6b56d]">No background pipeline tails.</p>}
                  {snapshot.pipeline.items.map((row) => (
                    <button key={`${row.executionSessionId}:${row.stage}`} type="button" onClick={() => void onOpenTask(row.taskId)} className="flex w-full cursor-pointer items-start justify-between gap-3 rounded-xl border border-[#eadbc6] bg-white px-3 py-2.5 text-left hover:border-[#d8a15f] hover:bg-[#fff9f1] dark:border-[#584a3b] dark:bg-[#211b16] dark:hover:bg-[#30271f]">
                      <div className="min-w-0"><div className="truncate text-[11px] font-extrabold">{row.displayId || row.taskId} · {row.title}</div><div className="mt-1 truncate text-[10px] font-mono text-[#8c7463] dark:text-[#d6b56d]">{row.activity || row.operationKind || row.lifecycleStage}</div></div>
                      <span className={`shrink-0 rounded-lg px-2 py-1 text-[9px] font-black ${row.blocked ? 'bg-[#f9d9cf] text-[#a33f25] dark:bg-[#4c2c24] dark:text-[#f0b29f]' : 'bg-[#f2e5d2] text-[#71543a] dark:bg-[#3a2f26] dark:text-[#e5c99d]'}`}>{PIPELINE_LABELS[row.stage] || row.stage}</span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-[#e5d4bb] bg-[#fffdfa] p-4 dark:border-[#584a3b] dark:bg-[#292119]">
              <div className="mb-3 flex items-center gap-2"><Bot size={16} className="text-[#d89745]" /><h2 className="text-sm font-extrabold">Queues & Attention</h2></div>
              <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-4">
                {(Object.keys(QUEUE_META) as AgentOfficeQueueState[]).map((state) => {
                  const meta = QUEUE_META[state];
                  const items = snapshot.queue.items[state];
                  return (
                    <div key={state} className="min-w-0 rounded-xl border border-[#e5d4bb] bg-white p-3 dark:border-[#584a3b] dark:bg-[#211b16]">
                      <div className="flex items-start justify-between gap-2"><div><h3 className="text-xs font-extrabold">{meta.label}</h3><p className="mt-0.5 text-[9px] text-[#8c7463] dark:text-[#d6b56d]">{meta.description}</p></div><span className="rounded-full bg-[#f2e5d2] px-2 py-1 text-[10px] font-black dark:bg-[#3a2f26]">{snapshot.queue.counts[state]}</span></div>
                      <div className="mt-3 space-y-1.5">
                        {items.length === 0 && <p className="py-2 text-[10px] font-mono text-[#a08a78] dark:text-[#bfa78f]">Empty</p>}
                        {items.map((item) => (
                          <button key={item.taskId} type="button" onClick={() => void onOpenTask(item.taskId)} className="block w-full cursor-pointer rounded-lg border border-transparent px-2 py-2 text-left hover:border-[#eadbc6] hover:bg-[#fff8ee] dark:hover:border-[#584a3b] dark:hover:bg-[#30271f]">
                            <div className="truncate text-[10px] font-extrabold">{item.displayId || item.taskId} · {item.title}</div>
                            {item.reasons[0]?.message && <div className="mt-1 line-clamp-2 text-[9px] leading-relaxed text-[#8c7463] dark:text-[#d6b56d]">{item.reasons[0].message}</div>}
                          </button>
                        ))}
                        {snapshot.queue.truncated[state] && <p className="px-2 text-[9px] font-mono text-[#9a7e68] dark:text-[#bfa78f]">More queued items…</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
