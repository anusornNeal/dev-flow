import type React from 'react';
import { Activity, ChevronDown, Clipboard, Plus } from 'lucide-react';
import type { Task } from '../../types';
import type { RunHistoryFiles } from './useRunArtifacts';

interface TaskDrawerActivityPanelProps {
  task: Task;
  openSections: Set<string>;
  handleAccordionClick: (e: React.MouseEvent<HTMLButtonElement>, key: string) => void;
  activeLogTab: 'notes' | 'autowork' | 'history';
  setActiveLogTab: (tab: 'notes' | 'autowork' | 'history') => void;
  newComment: string;
  setNewComment: (value: string) => void;
  handleAddComment: (e: React.FormEvent) => void;
  latestRun: Task['latestAgentRun'];
  autoWorkState: { label?: string; message?: string } | null | undefined;
  canRetryLatestRun: boolean;
  handleRetryLatestRun: () => void;
  isRetryingRun: boolean;
  latestRunLogLoading: boolean;
  latestRunLogError: string | null;
  latestRunLogExists: boolean;
  latestRunLogTail: string;
  runHistoryFiles: RunHistoryFiles | null;
  copiedHistoryPath: string | null;
  handleCopyHistoryPath: (pathValue: string) => void;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

const tabClass = (active: boolean) => `cursor-pointer border-b-2 pb-2 font-mono text-[10px] font-bold uppercase tracking-wider transition-colors ${
  active
    ? 'border-df-accent text-df-accent'
    : 'border-transparent text-df-text-muted hover:text-[var(--df-color-text-strong)]'
}`;

export function TaskDrawerActivityPanel({
  task,
  openSections,
  handleAccordionClick,
  activeLogTab,
  setActiveLogTab,
  newComment,
  setNewComment,
  handleAddComment,
  latestRun,
  autoWorkState,
  canRetryLatestRun,
  handleRetryLatestRun,
  isRetryingRun,
  latestRunLogLoading,
  latestRunLogError,
  latestRunLogExists,
  latestRunLogTail,
  runHistoryFiles,
  copiedHistoryPath,
  handleCopyHistoryPath,
  onShowLog,
}: TaskDrawerActivityPanelProps) {
  return (
    <div className="overflow-hidden rounded-2xl border border-df-border bg-df-surface">
      <button
        type="button"
        onClick={(e) => handleAccordionClick(e, 'activity')}
        className="flex w-full cursor-pointer items-center justify-between gap-3 p-3.5 transition-colors hover:bg-df-surface-muted"
        aria-expanded={openSections.has('activity')}
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-[var(--df-color-warning-surface)]">
            <Activity size={12} className="text-df-accent" />
          </div>
          <span className="truncate text-xs font-bold text-[var(--df-color-text-strong)]">Activity & Logs</span>
          <span className="rounded-md bg-df-surface-muted px-1.5 py-0.5 font-mono text-[10px] font-bold text-df-text-muted">
            {task.logs.length}
          </span>
        </div>
        <ChevronDown
          size={14}
          className={`shrink-0 text-df-text-muted transition-transform duration-200 ${openSections.has('activity') ? 'rotate-180' : ''}`}
        />
      </button>

      {openSections.has('activity') && (
        <div className="border-t border-df-border bg-df-surface">
          <div className="flex flex-wrap items-center gap-4 border-b border-df-border px-4 pt-3" role="tablist" aria-label="Activity log views">
            <button type="button" role="tab" aria-selected={activeLogTab === 'notes'} onClick={() => setActiveLogTab('notes')} className={tabClass(activeLogTab === 'notes')}>
              Notes ({task.logs.filter(l => l.type === 'comment').length})
            </button>
            <button type="button" role="tab" aria-selected={activeLogTab === 'autowork'} onClick={() => setActiveLogTab('autowork')} className={tabClass(activeLogTab === 'autowork')}>
              Auto-Work
            </button>
            <button type="button" role="tab" aria-selected={activeLogTab === 'history'} onClick={() => setActiveLogTab('history')} className={tabClass(activeLogTab === 'history')}>
              History ({task.logs.filter(l => l.type !== 'comment').length})
            </button>
          </div>

          <div className="space-y-4 p-4">
            {activeLogTab === 'notes' && (
              <>
                <div className="max-h-96 space-y-2 overflow-y-auto pr-1 scrollbar-thin">
                  {[...task.logs]
                    .filter(log => log.type === 'comment')
                    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                    .map((log) => (
                      <div key={log.id} className="flex flex-col gap-1 rounded-xl border border-df-border bg-df-surface-raised p-3 font-mono text-[10px] leading-relaxed text-df-text shadow-[var(--df-shadow-sm)]">
                        <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10px] font-extrabold uppercase text-df-text-muted">
                          <span className="flex items-center gap-1 text-df-accent"><Clipboard size={10} /> Note</span>
                          <span>{new Date(log.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                        </div>
                        <p className="whitespace-pre-wrap break-words">{log.message.replace(/^💬 Note: /, '')}</p>
                      </div>
                    ))}
                  {task.logs.filter(l => l.type === 'comment').length === 0 && (
                    <div className="py-4 text-center font-mono text-[10px] text-df-text-muted">No notes yet. Add one below.</div>
                  )}
                </div>

                <form onSubmit={handleAddComment} className="mt-2 flex min-w-0 gap-2 font-mono">
                  <input
                    type="text"
                    className="df-control min-w-0 flex-1 px-3.5 py-2 font-mono text-xs"
                    placeholder="Write a note or comment..."
                    value={newComment}
                    onChange={(e) => setNewComment(e.target.value)}
                  />
                  <button type="submit" className="df-button df-button--secondary min-w-0 px-4" title="Add Note" aria-label="Add note">
                    <Plus size={15} />
                  </button>
                </form>
              </>
            )}

            {activeLogTab === 'autowork' && (
              <div className="space-y-4">
                {latestRun ? (
                  <div className="space-y-2 rounded-2xl border border-df-border bg-df-surface-raised p-3 shadow-[var(--df-shadow-sm)]">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-mono text-[10px] font-extrabold uppercase tracking-widest text-df-text-muted">Latest Auto Work Status</div>
                        <div className="break-words text-[12px] font-bold text-[var(--df-color-text-strong)]">{autoWorkState?.label || latestRun.status}</div>
                      </div>
                      {canRetryLatestRun && (
                        <button type="button" onClick={handleRetryLatestRun} disabled={isRetryingRun} className="df-button df-button--secondary min-h-8 min-w-0 px-3 font-mono text-[10px]">
                          {isRetryingRun ? 'Retrying...' : 'Retry Run'}
                        </button>
                      )}
                    </div>
                    {latestRun.errorMessage && <div className="df-feedback df-feedback--danger"><div className="df-feedback__summary">Run failed</div><div className="df-feedback__detail df-break-technical">{latestRun.errorMessage}</div></div>}
                    {autoWorkState?.message && autoWorkState.message !== latestRun.errorMessage && <div className="break-words font-mono text-[10px] text-df-text-muted">{autoWorkState.message}</div>}
                  </div>
                ) : (
                  <div className="py-4 text-center font-mono text-[10px] text-df-text-muted">No auto-work runs initiated for this task yet.</div>
                )}

                <div className="space-y-2 rounded-2xl border border-df-border bg-df-surface-raised p-3 shadow-[var(--df-shadow-sm)]">
                  <div className="font-mono text-[10px] font-extrabold uppercase tracking-widest text-df-text-muted">Final Output</div>
                  {latestRunLogLoading && <div className="font-mono text-[10px] text-df-text-muted">Loading captured run log…</div>}
                  {!latestRunLogLoading && latestRunLogError && (
                    <div className="df-feedback df-feedback--danger"><div className="df-feedback__summary">Captured log unavailable</div><div className="df-feedback__detail df-break-technical">{latestRunLogError}</div></div>
                  )}
                  {!latestRunLogLoading && !latestRunLogError && !latestRun && <div className="font-mono text-[10px] text-df-text-muted">No run log yet.</div>}
                  {!latestRunLogLoading && !latestRunLogError && latestRun && !latestRunLogExists && <div className="font-mono text-[10px] text-df-text-muted">No captured run log yet.</div>}
                  {!latestRunLogLoading && !latestRunLogError && latestRunLogExists && (
                    <pre className="df-break-technical max-h-64 overflow-auto whitespace-pre-wrap rounded-xl bg-[var(--df-color-surface-subtle)] p-3 font-mono text-[10px] leading-relaxed text-df-text">
                      {latestRunLogTail || '(empty log)'}
                    </pre>
                  )}
                </div>

                {runHistoryFiles && (
                  <div className="space-y-2">
                    <div className="px-1 font-mono text-[10px] font-extrabold uppercase tracking-widest text-df-text-muted">Run History Files</div>
                    <div className="grid grid-cols-1 gap-2">
                      {[
                        ['Run Folder', runHistoryFiles.runDir], ['Prompt', runHistoryFiles.promptPath], ['Launch', runHistoryFiles.launchMetadataPath],
                        ['Summary', runHistoryFiles.outputSummaryPath], ['Result', runHistoryFiles.resultPath], ['Log', runHistoryFiles.logPath],
                      ].map(([label, pathValue]) => (
                        <button
                          key={label}
                          type="button"
                          onClick={() => {
                            if (label === 'Log' && onShowLog && task.latestAgentRun) {
                              onShowLog({ id: task.latestAgentRun.id, status: task.latestAgentRun.status, agent: task.agent, model: task.model });
                            } else {
                              handleCopyHistoryPath(pathValue);
                            }
                          }}
                          className="group w-full cursor-pointer rounded-xl border border-df-border bg-df-surface-raised px-3 py-2 text-left shadow-[var(--df-shadow-sm)] transition-colors hover:bg-df-surface-muted"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="font-mono text-[10px] font-extrabold uppercase text-df-text-muted">{label}</span>
                            <span className={`font-mono text-[10px] font-bold ${label === 'Log' ? 'text-df-info' : 'text-df-success opacity-0 transition-opacity group-hover:opacity-100'}`}>
                              {label === 'Log' ? 'view log' : copiedHistoryPath === pathValue ? 'copied' : 'copy path'}
                            </span>
                          </div>
                          <div className="df-truncate mt-1 font-mono text-[10px] text-df-text" title={pathValue}>{pathValue}</div>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeLogTab === 'history' && (
              <div className="relative max-h-96 space-y-0 overflow-y-auto pr-1 before:absolute before:inset-0 before:left-[12px] before:h-full before:w-px before:bg-df-border scrollbar-thin">
                {[...task.logs]
                  .filter(log => log.type !== 'comment')
                  .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                  .map((log) => (
                    <div key={log.id} className="relative flex items-start gap-3 py-2">
                      <div className={`z-10 ml-[8px] mt-1.5 h-2 w-2 shrink-0 rounded-full ring-4 ring-df-surface ${
                        log.type === 'create' ? 'bg-df-success' : log.type === 'move' ? 'bg-df-accent' : 'bg-df-text-muted'
                      }`} />
                      <div className="flex min-w-0 flex-1 flex-col pr-2">
                        <div className="mb-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                          <span className="font-mono text-[10px] font-bold uppercase tracking-widest text-[var(--df-color-text-strong)]">{log.type}</span>
                          <span className="font-mono text-[10px] text-df-text-muted">{new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</span>
                        </div>
                        <p className="break-words font-mono text-[10px] leading-snug text-df-text-muted">{log.message}</p>
                      </div>
                    </div>
                  ))}
                {task.logs.filter(l => l.type !== 'comment').length === 0 && (
                  <div className="py-4 text-center font-mono text-[10px] text-df-text-muted">No system history available.</div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
