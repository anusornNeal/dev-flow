import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { startReactiveServerRefresh } from '../lib/serverEvents';

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
    topTools?: Array<{ toolName?: string; count?: number; p50DurationMs?: number; p95DurationMs?: number; cacheHitCount?: number; responseBytes?: number; processSpawns?: number }>;
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
    const stopRefresh = startReactiveServerRefresh({
      refresh: load,
      eventTypes: ['job.changed', 'health.regression', 'cache.invalidated', 'task.changed', 'stream.reset'],
      fallbackMs: 60_000,
    });
    return () => {
      cancelled = true;
      stopRefresh();
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const failedJobs = (data?.mcp?.recentJobs || []).filter((job) => ['failed', 'timed_out', 'cancelled'].includes(job.status || '')).slice(0, 6);
  const recommendations = Array.from(new Set([...(data?.recommendations || []), ...(data?.tools?.recommendations || [])])).slice(0, 6);

  return (
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4">
      <button type="button" aria-label="Close observability backdrop" className="fixed inset-0 cursor-default" onClick={onClose} />
      <div className="df-dialog relative z-10 flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Observability diagnostics">
        <div className="df-dialog-header flex items-center justify-between gap-4 px-6 py-4">
          <div>
            <h2 className="df-heading-lg">MCP and agent health</h2>
            <p className="df-meta mt-1">{data?.generatedAt ? `Updated ${new Date(data.generatedAt).toLocaleString()}` : 'Diagnostics'}</p>
          </div>
          <button type="button" aria-label="Close observability" className="df-button df-button--secondary min-h-8 min-w-0" onClick={onClose}>Close</button>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          {error && <div className="df-feedback df-feedback--danger"><div className="df-feedback__summary">Diagnostics unavailable</div><div className="df-feedback__detail df-break-technical">{error}</div></div>}
          {!data && !error && <div className="df-feedback df-feedback--info"><div className="df-feedback__summary">Loading diagnostics…</div><div className="df-feedback__detail">Waiting for the latest MCP and agent health snapshot.</div></div>}
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
              <Panel title="Performance p50 / p95">{(data.tools?.topTools || []).slice(0, 8).map((tool) => <Row key={tool.toolName || 'tool'} main={`${tool.toolName || 'tool'} · ${tool.p50DurationMs || 0} / ${tool.p95DurationMs || 0} ms`} sub={`${tool.count || 0} calls · ${tool.cacheHitCount || 0} cache hits · ${tool.processSpawns || 0} process spawns · ${tool.responseBytes || 0} bytes`} />)}{(data.tools?.topTools || []).length === 0 && <Empty text="No performance samples" />}</Panel>
              {recommendations.length > 0 && <Panel title="Recommendations">{recommendations.map((item) => <div key={item} className="rounded-lg bg-blue-50 p-3 text-sm text-blue-900">{item}</div>)}</Panel>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return <div className="df-surface min-w-0 p-4"><div className="df-meta uppercase">{label}</div><div className="mt-2 text-3xl font-semibold text-[var(--df-color-text-strong)]">{value}</div></div>;
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="df-surface min-w-0 space-y-2 p-4"><h3 className="df-heading-sm break-words">{title}</h3>{children}</section>;
}

function Row({ main, sub }: { main: string; sub: string }) {
  return <div className="min-w-0 rounded-lg bg-[var(--df-color-surface-subtle)] p-3 text-sm"><div className="break-words font-medium text-[var(--df-color-text-strong)]">{main}</div><div className="df-meta df-break-technical mt-1">{sub}</div></div>;
}

function Empty({ text }: { text: string }) {
  return <p className="df-meta break-words">{text}</p>;
}
