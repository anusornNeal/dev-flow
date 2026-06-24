import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

interface ObservabilityModalProps {
  onClose: () => void;
}

type Diagnostics = {
  generatedAt?: string;
  mcp?: {
    queueDepth?: number;
    activeJobs?: Array<{ jobId: string; toolName: string; resourceKey?: string }>;
    queuedJobs?: Array<{ jobId: string; toolName: string; resourceKey?: string }>;
    recentJobs?: Array<{ id?: string; toolName?: string; status?: string; failureSummary?: string | null }>;
  };
  agents?: {
    activeCount?: number;
    staleCount?: number;
    activeRuns?: Array<{ id?: string; taskId?: string; agent?: string; status?: string; stale?: boolean }>;
    recentFailures?: Array<{ id?: string; taskId?: string; agent?: string; status?: string; errorMessage?: string }>;
  };
  tools?: {
    duplicateBursts?: Array<{ toolName?: string; count?: number; inputHash?: string }>;
    recommendations?: string[];
  };
  recommendations?: string[];
};

function short(value?: string) {
  if (!value) return '-';
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

export default function ObservabilityModal({ onClose }: ObservabilityModalProps) {
  const [data, setData] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch('/api/diagnostics');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const packet = await response.json();
        if (!cancelled) setData(packet);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load diagnostics');
      }
    }
    void load();
    const timer = window.setInterval(load, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const failedJobs = (data?.mcp?.recentJobs || []).filter((job) => ['failed', 'timed_out', 'cancelled'].includes(job.status || '')).slice(0, 6);
  const recommendations = Array.from(new Set([...(data?.recommendations || []), ...(data?.tools?.recommendations || [])])).slice(0, 6);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">MCP and agent health</h2>
            <p className="text-sm text-slate-500">{data?.generatedAt ? `Updated ${new Date(data.generatedAt).toLocaleString()}` : 'Diagnostics'}</p>
          </div>
          <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50" onClick={onClose}>Close</button>
        </div>
        <div className="max-h-[calc(90vh-76px)] space-y-4 overflow-y-auto p-6">
          {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}
          {!data && !error && <div className="rounded-xl border p-3 text-sm text-slate-500">Loading diagnostics…</div>}
          {data && (
            <>
              <div className="grid gap-3 md:grid-cols-4">
                <Metric label="Queue depth" value={data.mcp?.queueDepth || 0} />
                <Metric label="Active jobs" value={data.mcp?.activeJobs?.length || 0} />
                <Metric label="Active agents" value={data.agents?.activeCount || 0} />
                <Metric label="Stale agents" value={data.agents?.staleCount || 0} />
              </div>
              <Panel title="Active MCP jobs">{(data.mcp?.activeJobs || []).slice(0, 6).map((job) => <Row key={job.jobId} main={job.toolName} sub={`${short(job.jobId)} · ${job.resourceKey || 'no resource'}`} />)}{(data.mcp?.activeJobs || []).length === 0 && <Empty text="No active jobs" />}</Panel>
              <Panel title="Queued MCP jobs">{(data.mcp?.queuedJobs || []).slice(0, 6).map((job) => <Row key={job.jobId} main={job.toolName} sub={`${short(job.jobId)} · ${job.resourceKey || 'no resource'}`} />)}{(data.mcp?.queuedJobs || []).length === 0 && <Empty text="No queued jobs" />}</Panel>
              <Panel title="Recent MCP failures">{failedJobs.map((job) => <Row key={job.id || `${job.toolName}-${job.status}`} main={`${job.toolName || 'tool'} · ${job.status || 'unknown'}`} sub={job.failureSummary || 'No failure summary'} />)}{failedJobs.length === 0 && <Empty text="No recent MCP failures" />}</Panel>
              <Panel title="Active agent runs">{(data.agents?.activeRuns || []).slice(0, 6).map((run) => <Row key={run.id || run.taskId} main={`${run.agent || 'Agent'} · ${run.taskId || 'unknown task'}`} sub={`${run.status || 'unknown'}${run.stale ? ' · stale' : ''}`} />)}{(data.agents?.activeRuns || []).length === 0 && <Empty text="No active agent runs" />}</Panel>
              <Panel title="Duplicate tool bursts">{(data.tools?.duplicateBursts || []).slice(0, 6).map((burst, index) => <Row key={`${burst.toolName}-${burst.inputHash}-${index}`} main={`${burst.toolName || 'tool'} × ${burst.count || 0}`} sub={`input ${short(burst.inputHash)}`} />)}{(data.tools?.duplicateBursts || []).length === 0 && <Empty text="No duplicate bursts" />}</Panel>
              {recommendations.length > 0 && <Panel title="Recommendations">{recommendations.map((item) => <div key={item} className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{item}</div>)}</Panel>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="rounded-xl border border-slate-200 p-4"><div className="text-xs uppercase text-slate-500">{label}</div><div className="mt-2 text-3xl font-semibold text-slate-900">{value}</div></div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2 rounded-xl border border-slate-200 p-4"><h3 className="font-semibold text-slate-900">{title}</h3>{children}</section>;
}

function Row({ main, sub }: { main: string; sub: string }) {
  return <div className="rounded-lg bg-slate-50 p-3 text-sm"><div className="font-medium text-slate-900">{main}</div><div className="text-xs text-slate-500">{sub}</div></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="text-sm text-slate-500">{text}</p>;
}
