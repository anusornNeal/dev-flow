import React from 'react';
import { Clock3, Copy, FileText, MessageSquare, RefreshCw, ScrollText, TerminalSquare } from 'lucide-react';
import type { Task } from '../../types';
import type { RunHistoryFiles } from './useRunArtifacts';

interface TaskInspectorActivityTabProps {
  task: Task;
  newComment: string;
  setNewComment: (value: string) => void;
  onAddComment: (event: React.FormEvent) => void;
  canRetryLatestRun: boolean;
  isRetryingRun: boolean;
  onRetryLatestRun: () => void;
  latestRunLogLoading: boolean;
  latestRunLogError: string | null;
  latestRunLogExists: boolean;
  latestRunLogTail: string;
  runHistoryFiles: RunHistoryFiles | null;
  copiedHistoryPath: string | null;
  onCopyHistoryPath: (value: string) => void;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

function ActivitySection({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="df-surface min-w-0 p-5">
      <h3 className="df-heading-sm mb-3 flex items-center gap-2 uppercase tracking-[0.08em]">{icon}{title}</h3>
      {children}
    </section>
  );
}

export default function TaskInspectorActivityTab(props: TaskInspectorActivityTabProps) {
  const { task } = props;
  const latestRun = task.latestAgentRun;
  const noteLogs = (task.logs || []).filter((entry) => entry.type === 'comment' || entry.message.startsWith('💬 Note:'));

  return (
    <div className="mx-auto grid max-w-6xl min-w-0 gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="min-w-0 space-y-5">
        <ActivitySection title="Notes" icon={<MessageSquare size={15} />}>
          <form onSubmit={props.onAddComment} className="flex min-w-0 flex-col gap-2 sm:flex-row">
            <input value={props.newComment} onChange={(event) => props.setNewComment(event.target.value)} placeholder="Add a note…" className="df-control min-w-0 flex-1 text-[13px]" />
            <button type="submit" className="df-button df-button--primary min-w-0 sm:shrink-0">Add note</button>
          </form>
          <div className="mt-4 space-y-2">
            {noteLogs.length === 0 ? <p className="df-meta">No notes yet.</p> : noteLogs.slice().reverse().map((entry) => (
              <div key={entry.id} className="min-w-0 rounded-xl border border-[var(--df-color-border)] p-3">
                <p className="break-words text-[13px]">{entry.message.replace(/^💬 Note:\s*/, '')}</p>
                <p className="df-meta mt-1">{new Date(entry.timestamp).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </ActivitySection>

        <ActivitySection title="Task history" icon={<ScrollText size={15} />}>
          <div className="space-y-2">
            {(task.logs || []).slice().reverse().map((entry) => (
              <div key={entry.id} className="grid min-w-0 gap-2 rounded-xl border border-[var(--df-color-border)] p-3 sm:grid-cols-[120px_minmax(0,1fr)] sm:gap-3">
                <div className="df-meta font-mono">{new Date(entry.timestamp).toLocaleString()}</div>
                <div className="df-break-technical min-w-0 text-[12px] leading-5">{entry.message}</div>
              </div>
            ))}
            {(task.logs || []).length === 0 && <p className="df-meta">No task history.</p>}
          </div>
        </ActivitySection>
      </div>

      <div className="min-w-0 space-y-5">
        <ActivitySection title="Latest agent run" icon={<TerminalSquare size={15} />}>
          {latestRun ? (
            <div className="min-w-0 space-y-4">
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Run</span><code className="df-break-technical mt-1 block text-[12px]">{latestRun.id}</code></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Status</span><strong className="mt-1 block break-words text-[12px]">{latestRun.status}</strong></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Agent</span><strong className="mt-1 block break-words text-[12px]">{latestRun.agent || task.agent || 'Not assigned'}</strong></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Started</span><span className="mt-1 block text-[12px]">{latestRun.startedAt ? new Date(latestRun.startedAt).toLocaleString() : 'Not started'}</span></div>
              </div>
              {latestRun.errorMessage && <div className="df-feedback df-feedback--danger"><div className="df-feedback__summary">Latest run failed</div><div className="df-feedback__detail df-break-technical">{latestRun.errorMessage}</div></div>}
              {props.canRetryLatestRun && <button type="button" onClick={props.onRetryLatestRun} disabled={props.isRetryingRun} className="df-button df-button--secondary"><RefreshCw size={13} className={props.isRetryingRun ? 'animate-spin' : ''} /> {props.isRetryingRun ? 'Retrying…' : 'Retry run'}</button>}
            </div>
          ) : <p className="df-meta">No agent run recorded.</p>}
        </ActivitySection>

        <ActivitySection title="Execution log" icon={<FileText size={15} />}>
          {props.latestRunLogLoading ? <p className="df-meta">Loading latest run log…</p> : props.latestRunLogError ? <div className="df-feedback df-feedback--danger"><div className="df-feedback__summary">Execution log unavailable</div><div className="df-feedback__detail df-break-technical">{props.latestRunLogError}</div></div> : props.latestRunLogExists && props.latestRunLogTail ? (
            <details className="rounded-xl border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-3">
              <summary className="cursor-pointer text-[11px] font-extrabold text-[var(--df-color-text-muted)]">Show latest log tail</summary>
              <pre className="df-break-technical mt-3 max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-[#211a15] p-4 text-[11px] leading-5 text-[#e8dacb]">{props.latestRunLogTail}</pre>
              {props.onShowLog && latestRun && <button type="button" onClick={() => props.onShowLog?.({ id: latestRun.id, status: latestRun.status, agent: task.agent, model: task.model })} className="df-button df-button--secondary mt-3 min-h-8">Open log viewer</button>}
            </details>
          ) : <p className="df-meta">No run log is available.</p>}
        </ActivitySection>

        {props.runHistoryFiles && (
          <ActivitySection title="Run artifacts" icon={<Clock3 size={15} />}>
            <div className="space-y-2">
              {Object.entries(props.runHistoryFiles).filter(([, value]) => typeof value === 'string' && value).map(([key, value]) => (
                <div key={key} className="flex min-w-0 items-start gap-2 rounded-xl border border-[var(--df-color-border)] px-3 py-2">
                  <div className="min-w-0 flex-1"><span className="df-meta block uppercase">{key}</span><code className="df-break-technical mt-1 block text-[11px] leading-5" title={value}>{value}</code></div>
                  <button type="button" onClick={() => props.onCopyHistoryPath(value)} aria-label={`Copy ${key}`} className="df-icon-button shrink-0"><Copy size={12} />{props.copiedHistoryPath === value && <span className="sr-only">Copied</span>}</button>
                </div>
              ))}
            </div>
          </ActivitySection>
        )}
      </div>
    </div>
  );
}
