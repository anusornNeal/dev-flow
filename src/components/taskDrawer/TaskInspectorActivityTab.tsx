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
    <section className="rounded-2xl border border-[#eadbc5] bg-white/75 p-5 dark:border-[#584a3b] dark:bg-[#292119]/65">
      <h3 className="mb-3 flex items-center gap-2 text-[12px] font-black uppercase tracking-[0.08em] text-[#9a6427] dark:text-[#e0a070]">{icon}{title}</h3>
      {children}
    </section>
  );
}

export default function TaskInspectorActivityTab(props: TaskInspectorActivityTabProps) {
  const { task } = props;
  const latestRun = task.latestAgentRun;
  const noteLogs = (task.logs || []).filter((entry) => entry.type === 'comment' || entry.message.startsWith('💬 Note:'));

  return (
    <div className="mx-auto grid max-w-6xl gap-5 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
      <div className="space-y-5">
        <ActivitySection title="Notes" icon={<MessageSquare size={15} />}>
          <form onSubmit={props.onAddComment} className="flex gap-2">
            <input value={props.newComment} onChange={(event) => props.setNewComment(event.target.value)} placeholder="Add a note…" className="min-w-0 flex-1 rounded-xl border border-[#e3d2bb] bg-white px-3.5 py-2.5 text-[13px] outline-none focus:border-[#d89745] dark:border-[#584a3b] dark:bg-[#211a15]" />
            <button type="submit" className="rounded-xl bg-[#d89745] px-4 text-[11px] font-extrabold text-white">Add note</button>
          </form>
          <div className="mt-4 space-y-2">
            {noteLogs.length === 0 ? <p className="text-[12px] text-[#9a8879]">No notes yet.</p> : noteLogs.slice().reverse().map((entry) => (
              <div key={entry.id} className="rounded-xl border border-[#eadbc5] p-3 dark:border-[#584a3b]">
                <p className="text-[13px]">{entry.message.replace(/^💬 Note:\s*/, '')}</p>
                <p className="mt-1 text-[10px] text-[#9a8879]">{new Date(entry.timestamp).toLocaleString()}</p>
              </div>
            ))}
          </div>
        </ActivitySection>

        <ActivitySection title="Task history" icon={<ScrollText size={15} />}>
          <div className="space-y-2">
            {(task.logs || []).slice().reverse().map((entry) => (
              <div key={entry.id} className="grid grid-cols-[110px_minmax(0,1fr)] gap-3 rounded-xl border border-[#eadbc5] p-3 dark:border-[#584a3b]">
                <div className="text-[10px] font-mono text-[#9a8879]">{new Date(entry.timestamp).toLocaleString()}</div>
                <div className="text-[12px] leading-5">{entry.message}</div>
              </div>
            ))}
            {(task.logs || []).length === 0 && <p className="text-[12px] text-[#9a8879]">No task history.</p>}
          </div>
        </ActivitySection>
      </div>

      <div className="space-y-5">
        <ActivitySection title="Latest agent run" icon={<TerminalSquare size={15} />}>
          {latestRun ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-[#f8f1e6] p-3 dark:bg-[#211a15]"><span className="block text-[10px] font-bold uppercase text-[#927d6c]">Run</span><code className="mt-1 block text-[12px]">{latestRun.id}</code></div>
                <div className="rounded-xl bg-[#f8f1e6] p-3 dark:bg-[#211a15]"><span className="block text-[10px] font-bold uppercase text-[#927d6c]">Status</span><strong className="mt-1 block text-[12px]">{latestRun.status}</strong></div>
                <div className="rounded-xl bg-[#f8f1e6] p-3 dark:bg-[#211a15]"><span className="block text-[10px] font-bold uppercase text-[#927d6c]">Agent</span><strong className="mt-1 block text-[12px]">{latestRun.agent}</strong></div>
                <div className="rounded-xl bg-[#f8f1e6] p-3 dark:bg-[#211a15]"><span className="block text-[10px] font-bold uppercase text-[#927d6c]">Started</span><span className="mt-1 block text-[12px]">{latestRun.startedAt ? new Date(latestRun.startedAt).toLocaleString() : 'Not started'}</span></div>
              </div>
              {latestRun.errorMessage && <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-[12px] text-red-700 dark:border-red-900 dark:bg-red-950/20 dark:text-red-300">{latestRun.errorMessage}</p>}
              {props.canRetryLatestRun && <button type="button" onClick={props.onRetryLatestRun} disabled={props.isRetryingRun} className="flex items-center gap-2 rounded-xl border border-[#dfccb1] px-3 py-2 text-[11px] font-extrabold dark:border-[#584a3b]"><RefreshCw size={13} className={props.isRetryingRun ? 'animate-spin' : ''} /> Retry run</button>}
            </div>
          ) : <p className="text-[12px] text-[#9a8879]">No agent run recorded.</p>}
        </ActivitySection>

        <ActivitySection title="Execution log" icon={<FileText size={15} />}>
          {props.latestRunLogLoading ? <p className="text-[12px] text-[#9a8879]">Loading latest run log…</p> : props.latestRunLogError ? <p className="text-[12px] text-red-600">{props.latestRunLogError}</p> : props.latestRunLogExists && props.latestRunLogTail ? (
            <>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-xl bg-[#211a15] p-4 text-[11px] leading-5 text-[#e8dacb]">{props.latestRunLogTail}</pre>
              {props.onShowLog && latestRun && <button type="button" onClick={() => props.onShowLog?.({ id: latestRun.id, status: latestRun.status, agent: task.agent, model: task.model })} className="mt-2 rounded-lg border border-[#dfccb1] px-3 py-1.5 text-[11px] font-bold dark:border-[#584a3b]">Open log viewer</button>}
            </>
          ) : <p className="text-[12px] text-[#9a8879]">No run log is available.</p>}
        </ActivitySection>

        {props.runHistoryFiles && (
          <ActivitySection title="Run artifacts" icon={<Clock3 size={15} />}>
            <div className="space-y-2">
              {Object.entries(props.runHistoryFiles).filter(([, value]) => typeof value === 'string' && value).map(([key, value]) => (
                <div key={key} className="flex items-center gap-2 rounded-xl border border-[#eadbc5] px-3 py-2 dark:border-[#584a3b]">
                  <div className="min-w-0 flex-1"><span className="block text-[10px] font-bold uppercase text-[#927d6c]">{key}</span><code className="block truncate text-[11px]" title={value}>{value}</code></div>
                  <button type="button" onClick={() => props.onCopyHistoryPath(value)} aria-label={`Copy ${key}`} className="rounded-lg p-2 hover:bg-[#f8f1e6] dark:hover:bg-[#342920]"><Copy size={12} />{props.copiedHistoryPath === value && <span className="sr-only">Copied</span>}</button>
                </div>
              ))}
            </div>
          </ActivitySection>
        )}
      </div>
    </div>
  );
}
