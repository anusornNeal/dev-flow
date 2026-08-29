import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock3,
  GitMerge,
  Loader2,
  RefreshCw,
  ShieldAlert,
  UserRoundCog,
} from 'lucide-react';
import { getAgentOfficeProjection, type AgentOfficeProjection, type AgentOfficeQueueState } from '../client/apiClient';
import { GLOBAL_RUNTIME_INVALIDATION_EVENT_TYPES, startReactiveServerRefresh } from '../lib/serverEvents';

const STALE_SNAPSHOT_MS = 15_000;
const FALLBACK_REFRESH_MS = 60_000;
const LOCAL_AGE_TICK_MS = 15_000;

const QUEUE_META: Record<AgentOfficeQueueState, { label: string; description: string }> = {
  ready: { label: 'Ready to start', description: 'Runnable work waiting for an owner.' },
  execution: { label: 'Running queue', description: 'Tasks currently owned or executing.' },
  attention: { label: 'Needs attention', description: 'Reasoning, review, or handoff is required.' },
  blocked: { label: 'Blocked', description: 'A dependency or recovery step prevents progress.' },
};

const PIPELINE_LABELS: Record<string, string> = {
  'waiting-verification': 'Waiting for checks',
  verifying: 'Running checks',
  integrating: 'Merging changes',
  finalizing: 'Closing task',
  cleanup: 'Cleaning workspace',
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

export function advanceActivityAge(ageMs: number | null | undefined, generatedAt: string | null | undefined, nowMs = Date.now()) {
  if (ageMs == null || !Number.isFinite(ageMs)) return null;
  const generatedAtMs = Date.parse(String(generatedAt || ''));
  return Number.isFinite(generatedAtMs) ? ageMs + Math.max(0, nowMs - generatedAtMs) : ageMs;
}

type AgentOfficeRefreshGateOptions<T> = {
  fetchSnapshot: (signal: AbortSignal) => Promise<T>;
  isVisible: () => boolean;
  onStart?: (background: boolean) => void;
  onSnapshot: (snapshot: T) => void;
  onError: (error: unknown) => void;
  onSettled?: () => void;
  schedule?: (callback: () => void) => void;
};

export function createAgentOfficeRefreshGate<T>(options: AgentOfficeRefreshGateOptions<T>) {
  let disposed = false;
  let inFlight: Promise<void> | null = null;
  let dirty = false;
  let sequence = 0;
  let controller: AbortController | null = null;
  const schedule = options.schedule || ((callback: () => void) => queueMicrotask(callback));

  const request = (background = true): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (!options.isVisible()) {
      dirty = true;
      return Promise.resolve();
    }
    if (inFlight) {
      dirty = true;
      return inFlight;
    }

    dirty = false;
    const requestId = ++sequence;
    const currentController = new AbortController();
    controller = currentController;
    options.onStart?.(background);
    const run = (async () => {
      try {
        const next = await options.fetchSnapshot(currentController.signal);
        if (!disposed && !currentController.signal.aborted && requestId === sequence) options.onSnapshot(next);
      } catch (error) {
        if (!disposed && !currentController.signal.aborted && requestId === sequence) options.onError(error);
      } finally {
        if (controller === currentController) controller = null;
        inFlight = null;
        if (!disposed) options.onSettled?.();
        if (!disposed && dirty && options.isVisible()) {
          dirty = false;
          schedule(() => { void request(true); });
        }
      }
    })();
    inFlight = run;
    return run;
  };

  return {
    request,
    invalidate: () => {
      dirty = true;
      return request(true);
    },
    visibilityRestored: (force = false) => {
      if (force) dirty = true;
      return dirty ? request(true) : Promise.resolve();
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dirty = false;
      sequence += 1;
      controller?.abort();
      controller = null;
    },
    isInFlight: () => Boolean(inFlight),
    isDirty: () => dirty,
  };
}

function sourceLabel(source: string) {
  if (source === 'devflow-managed') return 'DevFlow managed';
  if (source === 'worker-native') return 'Local native';
  return 'Legacy agent';
}

function statusDotClass(indicator: string | null, stale: boolean) {
  if (stale || indicator === 'disconnected' || indicator === 'blocked') return 'bg-[var(--df-color-danger)]';
  if (indicator === 'attention') return 'bg-[var(--df-color-warning)]';
  return 'bg-[var(--df-color-success)]';
}

export type OfficeConnectionState = 'idle' | 'connecting' | 'connected' | 'fallback';

export function describeAgentOfficeHealth(input: {
  error?: string | null;
  partialSnapshot: boolean;
  staleSnapshot: boolean;
  connectionState: OfficeConnectionState;
}) {
  if (input.error) {
    return {
      tone: 'danger' as const,
      title: 'Refresh failed',
      detail: `Showing the last successful snapshot. ${input.error}`,
    };
  }
  if (input.partialSnapshot) {
    return {
      tone: 'warning' as const,
      title: 'Snapshot is partial',
      detail: `Some bounded sources were truncated, so counts and empty states may be incomplete.${input.staleSnapshot ? ' This snapshot is also stale.' : ''}`,
    };
  }
  if (input.staleSnapshot) {
    return {
      tone: 'warning' as const,
      title: 'Snapshot is stale',
      detail: 'Displayed work may be out of date. Refresh or wait for the live monitor to reconcile.',
    };
  }
  if (input.connectionState === 'fallback') {
    return {
      tone: 'warning' as const,
      title: 'Live updates interrupted',
      detail: 'The realtime stream is reconnecting. Bounded fallback refresh is active, so updates may arrive later than usual.',
    };
  }
  return null;
}

interface AgentOfficePageProps {
  onOpenTask: (taskId: string) => void | Promise<void>;
  initialSnapshot?: AgentOfficeProjection | null;
  initialError?: string | null;
  disableAutoLoad?: boolean;
  nowMs?: number;
}

export default function AgentOfficePage({
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
  const [connectionState, setConnectionState] = useState<OfficeConnectionState>(disableAutoLoad ? 'idle' : 'connecting');
  const [clockNowMs, setClockNowMs] = useState(() => nowMs ?? Date.now());
  const snapshotRef = useRef<AgentOfficeProjection | null>(initialSnapshot);
  const gateRef = useRef<ReturnType<typeof createAgentOfficeRefreshGate<AgentOfficeProjection>> | null>(null);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    if (nowMs !== undefined) {
      setClockNowMs(nowMs);
      return undefined;
    }
    const timer = window.setInterval(() => setClockNowMs(Date.now()), LOCAL_AGE_TICK_MS);
    return () => window.clearInterval(timer);
  }, [nowMs]);

  useEffect(() => {
    if (disableAutoLoad) return undefined;
    const isVisible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const gate = createAgentOfficeRefreshGate<AgentOfficeProjection>({
      fetchSnapshot: (signal) => getAgentOfficeProjection(20, { signal }),
      isVisible,
      onStart: (background) => {
        if (background) setRefreshing(true);
        else setLoading(true);
      },
      onSnapshot: (next) => {
        snapshotRef.current = next;
        setSnapshot(next);
        setError(null);
      },
      onError: (loadError) => setError(loadError instanceof Error ? loadError.message : 'Agent Office could not refresh.'),
      onSettled: () => {
        setLoading(false);
        setRefreshing(false);
      },
    });
    gateRef.current = gate;
    let wasUnavailable = false;
    void gate.request(Boolean(snapshotRef.current));
    const stopReactiveRefresh = startReactiveServerRefresh({
      refresh: () => gate.invalidate(),
      eventTypes: GLOBAL_RUNTIME_INVALIDATION_EVENT_TYPES,
      fallbackMs: FALLBACK_REFRESH_MS,
      initialRefresh: false,
      onAvailable: () => {
        setConnectionState('connected');
        if (wasUnavailable) {
          wasUnavailable = false;
          void gate.invalidate();
        }
      },
      onUnavailable: () => {
        wasUnavailable = true;
        setConnectionState('fallback');
      },
    });
    const handleVisibility = () => {
      if (!isVisible()) return;
      setClockNowMs(nowMs ?? Date.now());
      const current = snapshotRef.current;
      void gate.visibilityRestored(!current || isAgentOfficeSnapshotStale(current.generatedAt));
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      stopReactiveRefresh();
      if (gateRef.current === gate) gateRef.current = null;
      gate.dispose();
    };
  }, [disableAutoLoad, nowMs]);

  const requestRefresh = useCallback(() => {
    void gateRef.current?.request(true);
  }, []);

  const pipelineCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of snapshot?.pipeline.items || []) counts.set(row.stage, (counts.get(row.stage) || 0) + 1);
    return counts;
  }, [snapshot]);

  const effectiveNowMs = nowMs ?? clockNowMs;
  const staleSnapshot = snapshot ? isAgentOfficeSnapshotStale(snapshot.generatedAt, effectiveNowMs) : false;
  const queueTotal = snapshot
    ? Object.values(snapshot.queue.counts).reduce((sum, count) => sum + count, 0)
    : 0;
  const partialSnapshot = Boolean(snapshot && (
    snapshot.partial
    || snapshot.workers.truncated
    || snapshot.workers.sourceTruncated
    || snapshot.pipeline.truncated
    || snapshot.pipeline.sourceTruncated
    || snapshot.queue.partial
    || snapshot.queue.sourceTruncated
    || Object.values(snapshot.queue.truncated).some(Boolean)
  ));
  const reconnecting = connectionState === 'connecting' || connectionState === 'fallback';
  const incomplete = partialSnapshot || staleSnapshot || Boolean(error) || reconnecting;
  const exactZero = Boolean(snapshot) && snapshot!.workers.total === 0 && snapshot!.pipeline.total === 0 && queueTotal === 0;
  const empty = exactZero && !incomplete;
  const health = describeAgentOfficeHealth({ error, partialSnapshot, staleSnapshot, connectionState });

  const renderQueuePanel = (state: AgentOfficeQueueState) => {
    if (!snapshot) return null;
    const meta = QUEUE_META[state];
    const items = snapshot.queue.items[state];
    const attentionState = state === 'attention' || state === 'blocked';
    return (
      <div className={`min-w-0 rounded-[var(--df-radius-md)] border p-2.5 ${
        state === 'blocked'
          ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
          : state === 'attention'
            ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
            : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)]'
      }`}>
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className={`text-[12px] font-extrabold ${attentionState ? (state === 'blocked' ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-warning)]') : 'text-[var(--df-color-text-strong)]'}`}>{meta.label}</h3>
            <p className="mt-0.5 text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]">{meta.description}</p>
          </div>
          <span className="shrink-0 rounded-md bg-[var(--df-color-surface-muted)] px-2 py-1 text-[10px] font-extrabold text-[var(--df-color-text)]">{snapshot.queue.counts[state]}</span>
        </div>

        <div className="mt-2.5 space-y-1">
          {items.length === 0 && <p className="py-1 text-[10px] text-[var(--df-color-text-subtle)]">Nothing here right now.</p>}
          {items.map((item) => (
            <button
              key={`${item.projectId}:${item.taskId}`}
              type="button"
              onClick={() => void onOpenTask(item.taskId)}
              className="block w-full min-w-0 cursor-pointer rounded-[var(--df-radius-sm)] border border-transparent px-2 py-1.5 text-left transition-colors hover:border-[var(--df-color-border-strong)] hover:bg-[var(--df-color-surface-subtle)]"
            >
              <div className="truncate text-[9px] font-bold text-[var(--df-color-text-subtle)]" title={item.projectName}>{item.projectName}</div>
              <div className="mt-0.5 line-clamp-2 break-words text-[10px] font-extrabold text-[var(--df-color-text)]" title={`${item.displayId || item.taskId} · ${item.title}`}>
                {item.displayId || item.taskId} · {item.title}
              </div>
              {item.reasons[0]?.message && (
                <div className={`mt-1 line-clamp-2 break-words text-[9px] leading-relaxed ${state === 'blocked' ? 'text-[var(--df-color-danger)]' : state === 'attention' ? 'text-[var(--df-color-warning)]' : 'text-[var(--df-color-text-muted)]'}`} title={item.reasons[0].message}>
                  {item.reasons[0].message}
                </div>
              )}
            </button>
          ))}
          {snapshot.queue.truncated[state] && <p className="px-2 text-[9px] text-[var(--df-color-text-subtle)]">More items exist beyond this bounded view.</p>}
        </div>
      </div>
    );
  };

  if (loading && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center gap-3 text-xs font-bold text-[var(--df-color-text-muted)]" role="status">
        <Loader2 className="animate-spin" size={18} /> Loading Agent Office…
      </div>
    );
  }

  if (error && !snapshot) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="max-w-lg rounded-[var(--df-radius-lg)] border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] p-6">
          <div className="flex items-center gap-2 text-sm font-extrabold text-[var(--df-color-danger)]"><ShieldAlert size={18} /> Agent Office unavailable</div>
          <p className="mt-2 break-words text-xs leading-relaxed text-[var(--df-color-text)]">{error}</p>
          <button type="button" onClick={requestRefresh} className="df-button df-button--secondary mt-4">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[var(--df-color-canvas)] p-3.5 md:px-5 md:py-4 xl:px-6">
      <div className="mx-auto flex max-w-[1740px] flex-col gap-3">
        <div aria-label="Agent Office controls" className="flex min-w-0 flex-col gap-2 px-1 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-2 text-[10px] text-[var(--df-color-text-muted)]">
            <Activity size={14} className="shrink-0 text-[var(--df-color-accent)]" />
            <span className="font-extrabold text-[var(--df-color-text)]">All projects</span>
            <span className="min-w-0 truncate">Global operational view</span>
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 text-[10px] text-[var(--df-color-text-muted)]">
            {snapshot && <span className="shrink-0">Updated {new Date(snapshot.generatedAt).toLocaleTimeString()}</span>}
            {!disableAutoLoad && (
              <span className="min-w-0 truncate" title={connectionState === 'connected' ? 'Live updates connected' : connectionState === 'fallback' ? 'Live stream unavailable; fallback refresh active' : 'Connecting live updates'}>
                {connectionState === 'connected' ? 'Live updates connected' : connectionState === 'fallback' ? 'Fallback refresh active' : 'Connecting live updates'}
              </span>
            )}
            <button type="button" onClick={requestRefresh} disabled={refreshing} className="df-button df-button--secondary !min-h-8 !min-w-0 !px-2.5 !py-1.5">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {health && (
          <div
            className={`flex min-w-0 items-start gap-2 rounded-[var(--df-radius-md)] border px-3.5 py-2.5 text-xs ${
              health.tone === 'danger'
                ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
                : 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
            }`}
            role="status"
          >
            <AlertTriangle size={16} className={`mt-0.5 shrink-0 ${health.tone === 'danger' ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-warning)]'}`} />
            <div className="min-w-0">
              <strong className={health.tone === 'danger' ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-warning)]'}>{health.title}.</strong>{' '}
              <span className="break-words leading-relaxed text-[var(--df-color-text)]">{health.detail}</span>
            </div>
          </div>
        )}

        {empty ? (
          <div className="df-surface border-dashed px-6 py-12 text-center">
            <CheckCircle2 className="mx-auto text-[var(--df-color-success)]" size={28} />
            <h2 className="mt-3 text-sm font-extrabold text-[var(--df-color-text-strong)]">Agent Office is quiet</h2>
            <p className="mt-1 text-xs text-[var(--df-color-text-muted)]">No active workers, pipeline tails, queued work, or attention items right now.</p>
          </div>
        ) : snapshot && exactZero && incomplete ? (
          <div className="rounded-[var(--df-radius-lg)] border border-dashed border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] px-6 py-12 text-center">
            <AlertTriangle className="mx-auto text-[var(--df-color-warning)]" size={28} />
            <h2 className="mt-3 text-sm font-extrabold text-[var(--df-color-text-strong)]">Office state is incomplete</h2>
            <p className="mt-1 text-xs text-[var(--df-color-text-muted)]">No rows are visible, but this snapshot is partial, stale, or reconnecting, so zero is not conclusive.</p>
          </div>
        ) : snapshot ? (
          <>
            <section aria-label="Agent Office summary" className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
              {[
                { label: 'Active work', value: snapshot.workers.total, detail: 'Workers currently executing', tone: 'text-[var(--df-color-success)]' },
                { label: 'Needs attention', value: snapshot.queue.counts.attention, detail: 'Reasoning or handoff required', tone: 'text-[var(--df-color-warning)]' },
                { label: 'Blocked', value: snapshot.queue.counts.blocked, detail: 'Cannot progress yet', tone: 'text-[var(--df-color-danger)]' },
                { label: 'Ready to start', value: snapshot.queue.counts.ready, detail: 'Runnable work available', tone: 'text-[var(--df-color-info)]' },
              ].map((item) => (
                <div key={item.label} className="df-surface min-w-0 p-2.5">
                  <div className={`text-xl font-extrabold ${item.tone}`}>{item.value}</div>
                  <div className="mt-1 text-[11px] font-extrabold text-[var(--df-color-text-strong)]">{item.label}</div>
                  <div className="mt-0.5 text-[9px] leading-relaxed text-[var(--df-color-text-muted)]">{item.detail}</div>
                </div>
              ))}
            </section>

            <section className="df-surface p-3.5">
              <div className="mb-3 flex min-w-0 items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <UserRoundCog size={16} className="shrink-0 text-[var(--df-color-accent)]" />
                  <div className="min-w-0">
                    <h2 className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Active work</h2>
                    <p className="mt-0.5 text-[9.5px] text-[var(--df-color-text-muted)]">Who is working, on what, and whether execution needs intervention.</p>
                  </div>
                </div>
                <span className="shrink-0 rounded-md bg-[var(--df-color-surface-muted)] px-2 py-1 text-[10px] font-extrabold">{snapshot.workers.total}</span>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
                {snapshot.workers.items.length === 0 && <p className="rounded-[var(--df-radius-md)] border border-dashed border-[var(--df-color-border)] p-4 text-xs text-[var(--df-color-text-muted)] lg:col-span-2">No active workers are reporting work.</p>}
                {snapshot.workers.items.map((worker) => {
                  const workerState = worker.stale
                    ? 'Disconnected'
                    : worker.failure
                      ? 'Failed'
                      : worker.indicator === 'blocked'
                        ? 'Blocked'
                        : worker.indicator === 'attention'
                          ? 'Needs attention'
                          : 'Running';
                  const attention = workerState !== 'Running';
                  return (
                    <button
                      key={`${worker.projectId}:${worker.taskId}`}
                      type="button"
                      onClick={() => void onOpenTask(worker.taskId)}
                      className={`group flex w-full min-w-0 cursor-pointer items-start gap-3 rounded-[var(--df-radius-md)] border px-3 py-2.5 text-left transition-colors hover:border-[var(--df-color-border-strong)] hover:bg-[var(--df-color-surface-subtle)] ${
                        workerState === 'Blocked' || workerState === 'Failed' || workerState === 'Disconnected'
                          ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
                          : workerState === 'Needs attention'
                            ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
                            : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)]'
                      }`}
                    >
                      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${statusDotClass(worker.indicator, worker.stale)}`} />
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-2">
                          <span className="min-w-0 flex-1 truncate text-xs font-extrabold text-[var(--df-color-text-strong)]" title={worker.ownerLabel}>{worker.ownerLabel}</span>
                          <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-extrabold ${
                            attention
                              ? workerState === 'Needs attention'
                                ? 'border-[var(--df-color-warning)] text-[var(--df-color-warning)]'
                                : 'border-[var(--df-color-danger)] text-[var(--df-color-danger)]'
                              : 'border-[var(--df-color-success)] text-[var(--df-color-success)]'
                          }`}>{workerState}</span>
                        </div>

                        <div className="mt-1 line-clamp-2 break-words text-[11px] font-extrabold text-[var(--df-color-text)]" title={`${worker.displayId || worker.taskId} · ${worker.title}`}>
                          {worker.displayId || worker.taskId} · {worker.title}
                        </div>

                        <div className="mt-1.5 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[9px] text-[var(--df-color-text-muted)]">
                          <span className="max-w-[180px] truncate" title={worker.projectName}>{worker.projectName}</span>
                          <span>{sourceLabel(worker.source)}</span>
                          {worker.ownerKind && <span>{worker.ownerKind}</span>}
                          <span className="inline-flex items-center gap-1"><Clock3 size={10} /> {formatActivityAge(advanceActivityAge(worker.ageMs, snapshot.generatedAt, effectiveNowMs))}</span>
                        </div>

                        <div className="mt-1.5 line-clamp-2 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]" title={`${worker.action} · ${worker.phaseLabel}`}>
                          {worker.action} · {worker.phaseLabel}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
              {snapshot.workers.truncated && <p className="mt-2 px-1 text-[9px] text-[var(--df-color-text-subtle)]">More workers exist beyond this bounded view.</p>}
            </section>

            <section className="grid items-start gap-3 lg:grid-cols-2">
              {renderQueuePanel('attention')}
              {renderQueuePanel('blocked')}
            </section>

            <section className="grid items-start gap-3 xl:grid-cols-[0.9fr_1.4fr]">
              <div className="grid gap-3">
                {renderQueuePanel('ready')}
                {renderQueuePanel('execution')}
              </div>

              <div className="df-surface min-w-0 p-3.5">
                <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
                  <div className="flex min-w-0 items-start gap-2">
                    <GitMerge size={16} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
                    <div className="min-w-0">
                      <h2 className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Pipeline</h2>
                      <p className="mt-0.5 text-[9.5px] text-[var(--df-color-text-muted)]">Verification, integration, finalization, and cleanup still in flight.</p>
                    </div>
                  </div>
                  <span className="shrink-0 rounded-md bg-[var(--df-color-surface-muted)] px-2 py-1 text-[10px] font-extrabold">{snapshot.pipeline.total}</span>
                </div>

                <div className="mb-3 flex min-w-0 flex-wrap gap-1.5">
                  {Object.entries(PIPELINE_LABELS).map(([stage, label]) => (
                    <span key={stage} className="max-w-full truncate rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-2 py-1 text-[9px] font-bold text-[var(--df-color-text-muted)]" title={`${label}: ${pipelineCounts.get(stage) || 0}`}>
                      {label} {pipelineCounts.get(stage) || 0}
                    </span>
                  ))}
                </div>

                <div className="space-y-2">
                  {snapshot.pipeline.items.length === 0 && <p className="rounded-[var(--df-radius-md)] border border-dashed border-[var(--df-color-border)] p-4 text-xs text-[var(--df-color-text-muted)]">No pipeline work is currently in flight.</p>}
                  {snapshot.pipeline.items.map((row) => (
                    <button
                      key={`${row.projectId}:${row.executionSessionId}:${row.stage}`}
                      type="button"
                      onClick={() => void onOpenTask(row.taskId)}
                      className={`flex w-full min-w-0 cursor-pointer items-start justify-between gap-3 rounded-[var(--df-radius-md)] border px-3 py-2.5 text-left transition-colors hover:border-[var(--df-color-border-strong)] hover:bg-[var(--df-color-surface-subtle)] ${
                        row.blocked ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]' : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)]'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[9px] font-bold text-[var(--df-color-text-subtle)]" title={`${row.projectName} · ${row.ownerLabel}`}>{row.projectName} · {row.ownerLabel}</div>
                        <div className="mt-0.5 line-clamp-2 break-words text-[11px] font-extrabold text-[var(--df-color-text)]" title={`${row.displayId || row.taskId} · ${row.title}`}>
                          {row.displayId || row.taskId} · {row.title}
                        </div>
                        <div className="mt-1 line-clamp-2 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]" title={row.activity || row.operationKind || row.lifecycleStage}>
                          {row.activity || row.operationKind || row.lifecycleStage}
                        </div>
                      </div>
                      <span className={`max-w-[140px] shrink-0 truncate rounded-md border px-2 py-1 text-[9px] font-extrabold ${
                        row.blocked
                          ? 'border-[var(--df-color-danger)] text-[var(--df-color-danger)]'
                          : 'border-[var(--df-color-border)] text-[var(--df-color-text-muted)]'
                      }`} title={row.blocked ? `Blocked · ${PIPELINE_LABELS[row.stage] || row.stage}` : PIPELINE_LABELS[row.stage] || row.stage}>
                        {row.blocked ? `Blocked · ${PIPELINE_LABELS[row.stage] || row.stage}` : PIPELINE_LABELS[row.stage] || row.stage}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </section>

            <section className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[9px] text-[var(--df-color-text-subtle)]" aria-label="Snapshot technical details">
              <span>Scope: all projects</span>
              <span>Workers returned: {snapshot.workers.items.length}/{snapshot.workers.total}</span>
              <span>Pipeline returned: {snapshot.pipeline.items.length}/{snapshot.pipeline.total}</span>
              <span>Snapshot: {snapshot.generatedAt}</span>
            </section>
          </>
        ) : null}
      </div>
    </div>
  );
}
