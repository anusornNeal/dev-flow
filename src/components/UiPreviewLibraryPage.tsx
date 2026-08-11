import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, Link2, RefreshCw, Paperclip, FolderOpen, Loader2 } from 'lucide-react';
import { ApiError, apiGet } from '../client/apiClient';
import {
  attachUiPreviewToTask,
  createUiPreviewAttachAttemptStore,
  createUiPreviewLibraryRequestGate,
  getUiPreviewLibraryPage,
  type UiPreviewLibraryFilter,
  type UiPreviewLibraryItem,
  type UiPreviewLinkedTask,
} from '../client/uiPreviewClient';

interface UiPreviewLibraryPageProps {
  onOpenTask: (task: UiPreviewLinkedTask) => void | Promise<void>;
  initialItems?: UiPreviewLibraryItem[];
  disableAutoLoad?: boolean;
}

const FILTERS: Array<{ value: UiPreviewLibraryFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'standalone', label: 'Standalone' },
  { value: 'linked', label: 'Linked' },
];

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function summaryLabel(item: UiPreviewLibraryItem) {
  const screen = typeof item.specSummary.screen === 'string' ? item.specSummary.screen : '';
  return item.title || screen || item.previewId;
}

export default function UiPreviewLibraryPage({ onOpenTask, initialItems = [], disableAutoLoad = false }: UiPreviewLibraryPageProps) {
  const [filter, setFilter] = useState<UiPreviewLibraryFilter>('all');
  const [items, setItems] = useState<UiPreviewLibraryItem[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(!disableAutoLoad && initialItems.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [pendingAttach, setPendingAttach] = useState<Record<string, string>>({});
  const requestGate = useRef(createUiPreviewLibraryRequestGate());
  const attachStore = useRef(createUiPreviewAttachAttemptStore());
  const activeAttachTokens = useRef<Record<string, ReturnType<typeof attachStore.current.begin> extends infer T ? Exclude<T, null> : never>>({});
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGate.current.invalidate();
      attachStore.current.invalidate();
    };
  }, []);

  const load = useCallback(async (append = false, cursor: string | null = null) => {
    const token = requestGate.current.begin(filter);
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError(null);
    try {
      const page = await getUiPreviewLibraryPage({ filter, cursor, limit: 20 });
      if (!mounted.current || !requestGate.current.isCurrent(token)) return;
      setItems((current) => append ? [...current, ...page.items.filter((incoming) => !current.some((item) => item.previewId === incoming.previewId))] : page.items);
      setNextCursor(page.nextCursor);
    } catch (loadError) {
      if (!mounted.current || !requestGate.current.isCurrent(token)) return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load UI previews.');
    } finally {
      if (mounted.current && requestGate.current.isCurrent(token)) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    if (disableAutoLoad) return;
    setItems([]);
    setNextCursor(null);
    void load(false, null);
  }, [disableAutoLoad, filter, load]);

  const refresh = () => {
    requestGate.current.invalidate();
    setItems([]);
    setNextCursor(null);
    void load(false, null);
  };

  const copyLatest = async (item: UiPreviewLibraryItem) => {
    try {
      await navigator.clipboard.writeText(item.latestPreviewUrl);
      setFeedback((current) => ({ ...current, [item.previewId]: 'Latest link copied.' }));
    } catch (copyError) {
      setFeedback((current) => ({ ...current, [item.previewId]: copyError instanceof Error ? `Copy failed: ${copyError.message}` : 'Copy failed.' }));
    }
  };

  const attach = async (item: UiPreviewLibraryItem) => {
    const taskIdentifier = (taskInputs[item.previewId] || '').trim();
    if (!taskIdentifier) {
      setFeedback((current) => ({ ...current, [item.previewId]: 'Enter a task ID or display ID.' }));
      return;
    }
    const token = attachStore.current.begin(item.previewId, taskIdentifier);
    if (!token) return;
    const marker = `${token.idempotencyKey}:${token.generation}`;
    activeAttachTokens.current[item.previewId] = token;
    setPendingAttach((current) => ({ ...current, [item.previewId]: marker }));
    setFeedback((current) => ({ ...current, [item.previewId]: 'Capturing frozen evidence…' }));
    try {
      const evidence = await attachUiPreviewToTask({
        taskId: taskIdentifier,
        previewId: item.previewId,
        idempotencyKey: token.idempotencyKey,
      });
      const taskResult = await apiGet<any>(`/api/tasks/${encodeURIComponent(evidence.taskId || taskIdentifier)}?mode=summary`);
      const task = taskResult.data;
      if (!mounted.current || !attachStore.current.isCurrent(token)) return;
      attachStore.current.settle(token, 'terminal');
      delete activeAttachTokens.current[item.previewId];
      setItems((current) => current.map((candidate) => candidate.previewId === item.previewId ? {
        ...candidate,
        taskId: task.id,
        linkedTask: {
          id: task.id,
          displayId: task.displayId || null,
          title: task.title || task.id,
          projectId: task.projectId || null,
        },
      } : candidate));
      setFeedback((current) => ({ ...current, [item.previewId]: `Linked to ${task.displayId || task.id}. Frozen rev ${evidence.frozenRevision}.` }));
    } catch (attachError) {
      if (!mounted.current || !attachStore.current.isCurrent(token)) return;
      const uncertain = !(attachError instanceof ApiError);
      attachStore.current.settle(token, uncertain ? 'uncertain' : 'terminal');
      delete activeAttachTokens.current[item.previewId];
      setFeedback((current) => ({
        ...current,
        [item.previewId]: uncertain
          ? 'Connection result is uncertain. Retry will reuse the same request key.'
          : `Attach failed: ${attachError instanceof Error ? attachError.message : 'Unknown error'}`,
      }));
    } finally {
      if (mounted.current) {
        setPendingAttach((current) => {
          if (current[item.previewId] !== marker) return current;
          const next = { ...current };
          delete next[item.previewId];
          return next;
        });
      }
    }
  };

  const cancelAttach = (previewId: string) => {
    const token = activeAttachTokens.current[previewId];
    if (!token) return;
    attachStore.current.cancel(token);
    delete activeAttachTokens.current[previewId];
    setPendingAttach((current) => {
      const next = { ...current };
      delete next[previewId];
      return next;
    });
    setFeedback((current) => ({ ...current, [previewId]: 'Attach result ignored. Retry will reuse the same request key if the outcome was uncertain.' }));
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[#faf7f0] p-6 dark:bg-[#1e1914]" aria-label="UI Previews Library">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="mb-1 flex items-center gap-2 text-[10px] font-black uppercase tracking-[0.18em] text-[#a46c24] dark:text-[#d6b56d]">
            <span>Global</span><span>•</span><span>All local previews</span>
          </div>
          <h2 className="text-xl font-extrabold text-[#3e3129] dark:text-[#f3eadf]">UI Previews</h2>
          <p className="mt-1 text-xs text-[#816b5a] dark:text-[#d6b56d]">Live Library links always open the latest revision. Task Drawer evidence remains frozen.</p>
        </div>
        <button type="button" onClick={refresh} className="flex cursor-pointer items-center gap-2 rounded-xl border border-[#d8c5aa] bg-white px-3 py-2 text-xs font-bold text-[#714a1a] hover:bg-[#fff3de] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f3eadf]" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="mb-5 flex gap-2" role="tablist" aria-label="Preview filters">
        {FILTERS.map((entry) => (
          <button key={entry.value} type="button" role="tab" aria-selected={filter === entry.value} onClick={() => setFilter(entry.value)} className={`cursor-pointer rounded-xl border px-3 py-2 text-xs font-extrabold ${filter === entry.value ? 'border-[#d89745] bg-[#ffeace] text-[#714a1a] dark:border-[#f0b84d] dark:bg-[#3a2f26] dark:text-[#f3eadf]' : 'border-[#e5d4bb] bg-white text-[#816b5a] hover:bg-[#fff7ec] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#d6b56d]'}`}>
            {entry.label}
          </button>
        ))}
      </div>

      {error && <div className="mb-4 rounded-xl border border-[#e5a07c] bg-[#fff1e8] px-4 py-3 text-xs font-bold text-[#9a4f2d] dark:border-[#6d5642] dark:bg-[#33241c] dark:text-[#f3eadf]">{error}</div>}
      {loading && items.length === 0 && <div className="flex items-center gap-2 py-12 text-sm font-bold text-[#816b5a] dark:text-[#d6b56d]"><Loader2 size={16} className="animate-spin" /> Loading previews…</div>}
      {!loading && !error && items.length === 0 && <div className="rounded-2xl border border-dashed border-[#d8c5aa] bg-white/60 p-10 text-center text-sm font-bold text-[#816b5a] dark:border-[#584a3b] dark:bg-[#292119]/60 dark:text-[#d6b56d]">No previews match this filter.</div>}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        {items.map((item) => {
          const linked = Boolean(item.taskId && item.linkedTask);
          const pending = Boolean(pendingAttach[item.previewId]);
          return (
            <article key={item.previewId} className="rounded-2xl border border-[#e5d4bb] bg-white p-4 shadow-sm dark:border-[#584a3b] dark:bg-[#292119]">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-extrabold text-[#3e3129] dark:text-[#f3eadf]" title={summaryLabel(item)}>{summaryLabel(item)}</h3>
                  <p className="mt-1 font-mono text-[10px] text-[#917d71] dark:text-[#d6b56d]">{item.previewId}</p>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-black ${linked ? 'bg-[#e9f7e7] text-[#39713b] dark:bg-[#263a27] dark:text-[#b8dfb9]' : 'bg-[#fff0d6] text-[#95601e] dark:bg-[#3a2f26] dark:text-[#f0b84d]'}`}>{linked ? 'Linked' : 'Standalone'}</span>
              </div>

              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] font-bold text-[#816b5a] dark:text-[#d6b56d]">
                <span>Latest rev {item.latestRevision}</span>
                <span>Updated {formatUpdatedAt(item.updatedAt)}</span>
              </div>

              {linked && item.linkedTask && (
                <div className="mt-3 rounded-xl border border-[#e7dac6] bg-[#fffaf2] px-3 py-2 text-[11px] dark:border-[#584a3b] dark:bg-[#1e1914]">
                  <div className="font-extrabold text-[#534135] dark:text-[#f3eadf]">{item.linkedTask.displayId || item.linkedTask.id} · {item.linkedTask.title}</div>
                  <div className="mt-0.5 font-mono text-[9px] text-[#917d71] dark:text-[#d6b56d]">Project {item.linkedTask.projectId || 'unknown'}</div>
                </div>
              )}

              <div className="mt-4 flex flex-wrap gap-2">
                <a href={item.latestPreviewUrl} target="_blank" rel="noopener noreferrer" className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#d89745] bg-[#ffeace] px-2.5 py-2 text-[11px] font-extrabold text-[#714a1a] hover:bg-[#ffdfb4] dark:border-[#6d5642] dark:bg-[#3a2f26] dark:text-[#f3eadf]"><ExternalLink size={13} /> Open Latest Preview</a>
                <button type="button" onClick={() => void copyLatest(item)} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#d8c5aa] px-2.5 py-2 text-[11px] font-extrabold text-[#6e584a] hover:bg-[#fff7ec] dark:border-[#584a3b] dark:text-[#f3eadf]"><Link2 size={13} /> Copy Latest Link</button>
                {linked && item.linkedTask && <button type="button" onClick={() => void onOpenTask(item.linkedTask!)} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#d8c5aa] px-2.5 py-2 text-[11px] font-extrabold text-[#6e584a] hover:bg-[#fff7ec] dark:border-[#584a3b] dark:text-[#f3eadf]"><FolderOpen size={13} /> Open Task</button>}
              </div>

              {!linked && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-[#eadcc8] bg-[#fffaf2] p-2 dark:border-[#584a3b] dark:bg-[#1e1914]">
                  <input value={taskInputs[item.previewId] || ''} onChange={(event) => setTaskInputs((current) => ({ ...current, [item.previewId]: event.target.value }))} placeholder="Task ID, e.g. DVF-0502" className="min-w-48 flex-1 rounded-lg border border-[#d8c5aa] bg-white px-2.5 py-2 text-[11px] outline-none focus:border-[#d89745] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f3eadf]" disabled={pending} />
                  <button type="button" onClick={() => void attach(item)} disabled={pending} className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#a46c24] px-3 py-2 text-[11px] font-extrabold text-white disabled:cursor-not-allowed disabled:opacity-60"><Paperclip size={13} /> {pending ? 'Attaching…' : 'Attach to Task'}</button>
                  {pending && <button type="button" onClick={() => cancelAttach(item.previewId)} className="cursor-pointer rounded-lg border border-[#d8c5aa] px-2.5 py-2 text-[11px] font-extrabold text-[#6e584a] dark:border-[#584a3b] dark:text-[#f3eadf]">Cancel</button>}
                </div>
              )}
              {feedback[item.previewId] && <p className="mt-2 text-[10px] font-bold text-[#816b5a] dark:text-[#d6b56d]">{feedback[item.previewId]}</p>}
            </article>
          );
        })}
      </div>

      {nextCursor && (
        <div className="mt-5 flex justify-center">
          <button type="button" onClick={() => void load(true, nextCursor)} disabled={loadingMore} className="cursor-pointer rounded-xl border border-[#d8c5aa] bg-white px-4 py-2 text-xs font-extrabold text-[#714a1a] hover:bg-[#fff7ec] disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f3eadf]">{loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </section>
  );
}
