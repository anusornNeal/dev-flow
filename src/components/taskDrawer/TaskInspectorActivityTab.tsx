import React from 'react';
import { MessageSquare, ScrollText, TerminalSquare } from 'lucide-react';
import type { Task } from '../../types';

interface TaskInspectorActivityTabProps {
  task: Task;
  newComment: string;
  setNewComment: (value: string) => void;
  onAddComment: (event: React.FormEvent) => void;
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
  const liveWork = task.liveWork;
  const legacyRun = task.latestAgentRun;
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
        <ActivitySection title="Current activity" icon={<TerminalSquare size={15} />}>
          {liveWork ? (
            <div className="min-w-0 space-y-3">
              <div className={`df-feedback ${liveWork.blocked ? 'df-feedback--danger' : 'df-feedback--info'}`}>
                <div className="df-feedback__summary">{liveWork.blocked ? 'Blocked' : liveWork.phaseLabel}</div>
                <div className="df-feedback__detail df-break-technical">{liveWork.ownerLabel}{liveWork.activity ? ` · ${liveWork.activity}` : ''}</div>
              </div>
            </div>
          ) : <p className="df-meta">No canonical live work is currently active.</p>}
        </ActivitySection>

        {legacyRun && (
          <ActivitySection title="Historical legacy run" icon={<TerminalSquare size={15} />}>
            <div className="min-w-0 space-y-3">
              <div className="df-feedback df-feedback--info"><div className="df-feedback__summary">Read-only legacy history</div><div className="df-feedback__detail">This record is historical evidence only and does not control current task status or recovery.</div></div>
              <div className="grid min-w-0 gap-3 sm:grid-cols-2">
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Run</span><code className="df-break-technical mt-1 block text-[12px]">{legacyRun.id}</code></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Historical status</span><strong className="mt-1 block break-words text-[12px]">{legacyRun.status}</strong></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Legacy agent</span><strong className="mt-1 block break-words text-[12px]">{legacyRun.agent || 'Not recorded'}</strong></div>
                <div className="min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3"><span className="df-meta block uppercase">Started</span><span className="mt-1 block text-[12px]">{legacyRun.startedAt ? new Date(legacyRun.startedAt).toLocaleString() : 'Not recorded'}</span></div>
              </div>
              {legacyRun.errorMessage && <div className="df-meta df-break-technical">Historical error: {legacyRun.errorMessage}</div>}
            </div>
          </ActivitySection>
        )}
      </div>
    </div>
  );
}
