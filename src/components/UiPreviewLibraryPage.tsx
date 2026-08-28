import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, FolderOpen, Link2, Loader2, Paperclip, RefreshCw, Trash2 } from 'lucide-react';
import { ApiError, apiGet } from '../client/apiClient';
import { subscribeServerEvents } from '../lib/serverEvents';
import {
  attachUiPreviewToTask,
  createUiPreviewAttachAttemptStore,
  createUiPreviewLibraryRequestGate,
  deleteUiPreview,
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

export type PreviewFeedbackKind = 'pending' | 'success' | 'uncertain' | 'error' | 'info';

export interface PreviewFeedbackState {
  kind: PreviewFeedbackKind;
  summary: string;
  detail?: string;
  nextAction?: string;
}

export function previewFeedbackToneClass(kind: PreviewFeedbackKind) {
  if (kind === 'error') return 'df-feedback--danger';
  if (kind === 'uncertain') return 'df-feedback--warning';
  if (kind === 'success') return 'df-feedback--success';
  return 'df-feedback--info';
}

export function resolvePreviewFilterKey(active: UiPreviewLibraryFilter, key: string): UiPreviewLibraryFilter | null {
  const index = FILTERS.findIndex((entry) => entry.value === active);
  if (index < 0) return null;
  if (key === 'Home') return FILTERS[0].value;
  if (key === 'End') return FILTERS[FILTERS.length - 1].value;
  if (key === 'ArrowRight') return FILTERS[(index + 1) % FILTERS.length].value;
  if (key === 'ArrowLeft') return FILTERS[(index - 1 + FILTERS.length) % FILTERS.length].value;
  return null;
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value || 'Unknown';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function summaryLabel(item: UiPreviewLibraryItem) {
  const screen = typeof item.specSummary.screen === 'string' ? item.specSummary.screen : '';
  return item.title || screen || 'Untitled preview';
}

function workspaceSummary(item: UiPreviewLibraryItem) {
  if (!item.screenCount || item.screenCount <= 1) return null;
  const defaultName = item.defaultScreenSummary?.name
    || (typeof item.defaultScreenSummary?.specSummary.screen === 'string' ? item.defaultScreenSummary.specSummary.screen : '');
  return defaultName ? `${item.screenCount} screens · Default ${defaultName}` : `${item.screenCount} screens`;
}

function PreviewFeedback({ state }: { state: PreviewFeedbackState }) {
  return (
    <div
      aria-live="polite"
      data-feedback-kind={state.kind}
      className={`df-feedback ${previewFeedbackToneClass(state.kind)} min-w-0`}
    >
      <div className="df-feedback__summary break-words">{state.summary}</div>
      {state.detail && <div className="df-feedback__detail df-break-technical">{state.detail}</div>}
      {state.nextAction && (
        <div className="mt-2 min-w-0 border-t border-[var(--df-color-border)] pt-2 text-[10px] font-semibold leading-5">
          <span className="font-black uppercase tracking-[0.08em] opacity-70">Next action</span>
          <span className="ml-2 break-words">{state.nextAction}</span>
        </div>
      )}
    </div>
  );
}

export default function UiPreviewLibraryPage({ onOpenTask, initialItems = [], disableAutoLoad = false }: UiPreviewLibraryPageProps) {
  const [filter, setFilter] = useState<UiPreviewLibraryFilter>('all');
  const [items, setItems] = useState<UiPreviewLibraryItem[]>(initialItems);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(!disableAutoLoad && initialItems.length === 0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, PreviewFeedbackState>>({});
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [pendingAttach, setPendingAttach] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<Record<string, boolean>>({});
  const requestGate = useRef(createUiPreviewLibraryRequestGate());
  const attachStore = useRef(createUiPreviewAttachAttemptStore());
  const activeAttachTokens = useRef<Record<string, ReturnType<typeof attachStore.current.begin> extends infer T ? Exclude<T, null> : never>>({});
  const filterRefs = useRef<Partial<Record<UiPreviewLibraryFilter, HTMLButtonElement | null>>>({});
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGate.current.invalidate();
      attachStore.current.invalidate();
    };
  }, []);

  const load = useCallback(async (mode: 'initial' | 'background' | 'append' = 'initial', cursor: string | null = null) => {
    const append = mode === 'append';
    const background = mode === 'background';
    const token = requestGate.current.begin(filter);
    if (append) setLoadingMore(true);
    else if (!background) setLoading(true);
    if (!background) setError(null);
    try {
      const page = await getUiPreviewLibraryPage({ filter, cursor, limit: 20 });
      if (!mounted.current || !requestGate.current.isCurrent(token)) return;
      setItems((current) => append ? [...current, ...page.items.filter((incoming) => !current.some((item) => item.previewId === incoming.previewId))] : page.items);
      setNextCursor(page.nextCursor);
      setError(null);
    } catch (loadError) {
      if (!mounted.current || !requestGate.current.isCurrent(token)) return;
      setError(loadError instanceof Error ? loadError.message : 'Failed to load UI previews.');
    } finally {
      if (mounted.current && requestGate.current.isCurrent(token)) {
        if (!background) setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [filter]);

  useEffect(() => {
    if (disableAutoLoad) return;
    setItems([]);
    setNextCursor(null);
    void load('initial', null);
  }, [disableAutoLoad, filter, load]);

  useEffect(() => {
    if (disableAutoLoad) return;
    return subscribeServerEvents((event) => {
      if (event.type !== 'ui-preview.changed') return;
      void load('background', null);
    });
  }, [disableAutoLoad, load]);

  const refresh = () => {
    requestGate.current.invalidate();
    setNextCursor(null);
    void load('background', null);
  };

  const removePreview = async (item: UiPreviewLibraryItem) => {
    const label = summaryLabel(item);
    const confirmed = window.confirm(`Delete “${label}”? This permanently removes the standalone preview and all of its revisions.`);
    if (!confirmed) return;
    setPendingDelete((current) => ({ ...current, [item.previewId]: true }));
    setFeedback((current) => ({
      ...current,
      [item.previewId]: {
        kind: 'pending',
        summary: 'Deleting preview…',
        detail: 'The standalone preview and all revisions are being removed.',
      },
    }));
    try {
      await deleteUiPreview(item.previewId);
      if (!mounted.current) return;
      setItems((current) => current.filter((candidate) => candidate.previewId !== item.previewId));
      setFeedback((current) => {
        const next = { ...current };
        delete next[item.previewId];
        return next;
      });
    } catch (deleteError) {
      if (!mounted.current) return;
      setFeedback((current) => ({
        ...current,
        [item.previewId]: {
          kind: 'error',
          summary: 'Delete failed',
          detail: deleteError instanceof Error ? deleteError.message : 'Unknown error',
          nextAction: 'The preview is still available. Review the error and retry Delete when ready.',
        },
      }));
    } finally {
      if (mounted.current) {
        setPendingDelete((current) => {
          const next = { ...current };
          delete next[item.previewId];
          return next;
        });
      }
    }
  };

  const copyLatest = async (item: UiPreviewLibraryItem) => {
    try {
      await navigator.clipboard.writeText(item.latestPreviewUrl);
      setFeedback((current) => ({
        ...current,
        [item.previewId]: { kind: 'success', summary: 'Latest link copied', detail: 'The live preview URL is ready to paste.' },
      }));
    } catch (copyError) {
      setFeedback((current) => ({
        ...current,
        [item.previewId]: {
          kind: 'error',
          summary: 'Copy failed',
          detail: copyError instanceof Error ? copyError.message : 'Clipboard access failed.',
          nextAction: 'Check browser clipboard permission and try Copy Latest Link again.',
        },
      }));
    }
  };

  const attach = async (item: UiPreviewLibraryItem) => {
    const taskIdentifier = (taskInputs[item.previewId] || '').trim();
    if (!taskIdentifier) {
      setFeedback((current) => ({
        ...current,
        [item.previewId]: {
          kind: 'info',
          summary: 'Task ID required',
          detail: 'Enter a task ID or display ID before attaching evidence.',
        },
      }));
      return;
    }
    const token = attachStore.current.begin(item.previewId, taskIdentifier);
    if (!token) return;
    const marker = `${token.idempotencyKey}:${token.generation}`;
    activeAttachTokens.current[item.previewId] = token;
    setPendingAttach((current) => ({ ...current, [item.previewId]: marker }));
    setFeedback((current) => ({
      ...current,
      [item.previewId]: {
        kind: 'pending',
        summary: 'Capturing frozen evidence…',
        detail: `Attaching the latest preview revision to ${taskIdentifier}.`,
      },
    }));
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
      setFeedback((current) => ({
        ...current,
        [item.previewId]: {
          kind: 'success',
          summary: `Linked to ${task.displayId || task.id}`,
          detail: `Frozen revision ${evidence.frozenRevision} is now attached as task evidence.`,
          nextAction: 'Open the task to inspect the frozen evidence in context.',
        },
      }));
    } catch (attachError) {
      if (!mounted.current || !attachStore.current.isCurrent(token)) return;
      const uncertain = !(attachError instanceof ApiError);
      attachStore.current.settle(token, uncertain ? 'uncertain' : 'terminal');
      delete activeAttachTokens.current[item.previewId];
      setFeedback((current) => ({
        ...current,
        [item.previewId]: uncertain
          ? {
              kind: 'uncertain',
              summary: 'Connection outcome uncertain',
              detail: 'No confirmed response was received, so the attach may already have succeeded.',
              nextAction: 'Retry will reuse the same request key to avoid duplicate evidence. Choose Attach to Task again when you are ready.',
            }
          : {
              kind: 'error',
              summary: 'Attach failed',
              detail: attachError instanceof Error ? attachError.message : 'Unknown error',
              nextAction: 'Check the task identifier or reported error, then retry the attach.',
            },
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
    setFeedback((current) => ({
      ...current,
      [previewId]: {
        kind: 'uncertain',
        summary: 'Attach result ignored',
        detail: 'The local wait was cancelled, so DevFlow cannot confirm the final connection outcome here.',
        nextAction: 'Retry when ready. The same request key is reused if the prior outcome was uncertain.',
      },
    }));
  };

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-[var(--df-color-canvas)] p-4 sm:p-6" aria-label="UI Previews Library">
      <div className="mb-5 flex min-w-0 flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 max-w-3xl">
          <div className="df-meta mb-1 flex flex-wrap items-center gap-2 font-black uppercase tracking-[0.16em]">
            <span>Global</span><span aria-hidden="true">•</span><span>All local previews</span>
          </div>
          <h2 className="df-heading-lg break-words">UI Previews</h2>
          <p className="df-meta mt-1 max-w-2xl break-words leading-5">Library links always open the latest revision. Linked task evidence stays frozen at the attached revision.</p>
        </div>
        <button type="button" onClick={refresh} className="df-button df-button--secondary shrink-0" disabled={loading}>
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </div>

      <div className="mb-5 flex min-w-0 gap-1 overflow-x-auto border-b border-[var(--df-color-border)] pb-2" role="tablist" aria-label="Preview filters">
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            ref={(node) => { filterRefs.current[entry.value] = node; }}
            type="button"
            role="tab"
            aria-selected={filter === entry.value}
            tabIndex={filter === entry.value ? 0 : -1}
            onClick={() => setFilter(entry.value)}
            onKeyDown={(event) => {
              const next = resolvePreviewFilterKey(entry.value, event.key);
              if (!next) return;
              event.preventDefault();
              setFilter(next);
              filterRefs.current[next]?.focus();
            }}
            className={`df-button min-h-9 flex-none px-3 ${filter === entry.value ? 'df-button--primary' : 'df-button--secondary'}`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="df-feedback df-feedback--danger mb-4 min-w-0" role="alert">
          <div className="df-feedback__summary">Preview library unavailable</div>
          <div className="df-feedback__detail df-break-technical">{error}</div>
          <div className="mt-2 text-[10px] font-semibold">Use Refresh to retry without discarding previews already shown.</div>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="df-surface flex min-h-40 items-center justify-center gap-2 p-8 text-sm font-bold text-[var(--df-color-text-muted)]" aria-live="polite">
          <Loader2 size={16} className="animate-spin" /> Loading previews…
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="df-surface min-h-40 border-dashed p-8 text-center">
          <div className="df-heading-sm">No previews match this filter</div>
          <p className="df-meta mt-2">Choose another filter or Refresh to check for newly created previews.</p>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
        {items.map((item) => {
          const linked = Boolean(item.taskId && item.linkedTask);
          const pending = Boolean(pendingAttach[item.previewId]);
          const workspace = workspaceSummary(item);
          const deleting = Boolean(pendingDelete[item.previewId]);
          const itemFeedback = feedback[item.previewId];
          return (
            <article key={item.previewId} className="df-surface min-w-0 overflow-hidden p-4 shadow-sm sm:p-5">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h3 className="break-words text-sm font-extrabold leading-5 text-[var(--df-color-text-strong)]" title={summaryLabel(item)}>{summaryLabel(item)}</h3>
                  {workspace && <p className="df-meta mt-1 break-words">{workspace}</p>}
                </div>
                <div className="shrink-0 text-right">
                  <span className={`inline-flex rounded-full px-2 py-1 text-[10px] font-black ${linked ? 'bg-[var(--df-color-success-surface)] text-[var(--df-color-success)]' : 'bg-[var(--df-color-warning-surface)] text-[var(--df-color-warning)]'}`}>{linked ? 'Linked' : 'Standalone'}</span>
                  <div className="df-meta mt-1 text-[9px]">{linked ? 'Frozen task evidence' : 'Library only'}</div>
                </div>
              </div>

              <div className="df-meta mt-3 flex min-w-0 flex-wrap gap-x-4 gap-y-1">
                <span>Latest rev {item.latestRevision}</span>
                <span className="break-words">Updated {formatUpdatedAt(item.updatedAt)}</span>
              </div>

              {linked && item.linkedTask && (
                <div className="mt-4 min-w-0 rounded-xl border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-3">
                  <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]">Linked task</div>
                  <div className="mt-1 min-w-0 break-words text-[12px] font-extrabold text-[var(--df-color-text-strong)]">
                    <span className="df-break-technical">{item.linkedTask.displayId || item.linkedTask.id}</span>
                    <span aria-hidden="true"> · </span>
                    {item.linkedTask.title}
                  </div>
                  <div className="df-meta df-break-technical mt-1">Project {item.linkedTask.projectId || 'unknown'}</div>
                </div>
              )}

              <div data-preview-actions="normal" className="mt-4 flex min-w-0 flex-wrap gap-2">
                <a href={item.latestPreviewUrl} target="_blank" rel="noopener noreferrer" className="df-button df-button--primary min-w-0 max-w-full"><ExternalLink size={13} className="shrink-0" /> <span className="break-words">Open Latest Preview</span></a>
                <button type="button" onClick={() => void copyLatest(item)} className="df-button df-button--secondary min-w-0 max-w-full"><Link2 size={13} className="shrink-0" /> <span className="break-words">Copy Latest Link</span></button>
                {linked && item.linkedTask && (
                  <button type="button" onClick={() => void onOpenTask(item.linkedTask!)} className="df-button df-button--secondary min-w-0 max-w-full"><FolderOpen size={13} className="shrink-0" /> <span className="break-words">Open Task</span></button>
                )}
              </div>

              {!linked && (
                <div className="mt-4 min-w-0 rounded-xl border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-3">
                  <div className="mb-2 min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]">Attach frozen evidence</div>
                    <p className="df-meta mt-1 break-words">Link this preview to a task while preserving the selected revision as evidence.</p>
                  </div>
                  <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
                    <label className="sr-only" htmlFor={`preview-task-${item.previewId}`}>Task ID or display ID</label>
                    <input
                      id={`preview-task-${item.previewId}`}
                      value={taskInputs[item.previewId] || ''}
                      onChange={(event) => setTaskInputs((current) => ({ ...current, [item.previewId]: event.target.value }))}
                      placeholder="Task ID, e.g. DVF-0502"
                      className="df-control min-w-0 flex-1 text-[11px]"
                      disabled={pending}
                    />
                    <button type="button" onClick={() => void attach(item)} disabled={pending} className="df-button df-button--primary shrink-0"><Paperclip size={13} /> {pending ? 'Attaching…' : 'Attach to Task'}</button>
                    {pending && <button type="button" onClick={() => cancelAttach(item.previewId)} className="df-button df-button--secondary shrink-0">Cancel</button>}
                  </div>
                </div>
              )}

              {itemFeedback && <div className="mt-3"><PreviewFeedback state={itemFeedback} /></div>}

              {!linked && (
                <div data-preview-actions="destructive" className="mt-4 flex min-w-0 items-center justify-between gap-3 border-t border-[var(--df-color-border)] pt-3">
                  <div className="min-w-0">
                    <div className="text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-subtle)]">Destructive action</div>
                    <p className="df-meta mt-0.5 break-words">Delete permanently removes this standalone preview and all revisions.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void removePreview(item)}
                    disabled={deleting || pending}
                    aria-label={`Delete preview ${summaryLabel(item)}`}
                    className="df-button df-button--secondary shrink-0 text-[var(--df-color-danger)] hover:!bg-[var(--df-color-danger-surface)]"
                  >
                    <Trash2 size={13} /> {deleting ? 'Deleting…' : 'Delete preview'}
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>

      {nextCursor && (
        <div className="mt-5 flex justify-center">
          <button type="button" onClick={() => void load('append', nextCursor)} disabled={loadingMore} className="df-button df-button--secondary">{loadingMore ? 'Loading…' : 'Load more'}</button>
        </div>
      )}
    </section>
  );
}
