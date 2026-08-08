import React from 'react';
import { AlertTriangle, ShieldAlert, X } from 'lucide-react';

export interface TaskMoveBlocker {
  code: string;
  message: string;
  bypassable?: boolean;
  details?: unknown;
}

export interface TaskMoveDecision {
  code?: string;
  message?: string;
  confirmationRequired?: boolean;
  blockers: TaskMoveBlocker[];
}

export interface TaskMoveDialogModel {
  isHardBlocked: boolean;
  canMoveAnyway: boolean;
  summary: string;
  actions: string[];
}

export function buildTaskMoveDialogModel(decision: TaskMoveDecision): TaskMoveDialogModel {
  const blockers = Array.isArray(decision.blockers) ? decision.blockers : [];
  const isHardBlocked = decision.code === 'MOVE_HARD_BLOCKED' || blockers.some((blocker) => blocker.bypassable !== true);
  const canMoveAnyway = blockers.length > 0
    && decision.confirmationRequired === true
    && blockers.every((blocker) => blocker.bypassable === true);

  const actions = new Set<string>();
  for (const blocker of blockers) {
    if (blocker.code === 'ACTIVE_AGENT_LOCK') {
      actions.add('Cancel or complete the active agent run, then try again.');
    } else if (blocker.code.includes('LOCK') || blocker.code.includes('CONFLICT')) {
      actions.add('Resolve the active lock or conflict, then try again.');
    } else if (blocker.bypassable === true) {
      actions.add('Resolve the workflow checks above, or choose Move Anyway if you intentionally want to bypass them.');
    } else {
      actions.add('Resolve the blocking condition above, then try the move again.');
    }
  }

  if (actions.size === 0) {
    actions.add(isHardBlocked
      ? 'Resolve the blocking condition, then try the move again.'
      : 'Review the workflow checks before continuing.');
  }

  return {
    isHardBlocked,
    canMoveAnyway,
    summary: isHardBlocked
      ? 'This move is blocked for safety and cannot be overridden.'
      : 'This move is paused by workflow checks.',
    actions: Array.from(actions),
  };
}

interface TaskMoveBlockerDialogProps {
  decision: TaskMoveDecision;
  sourceLabel: string;
  targetLabel: string;
  onMoveAnyway: () => void;
  onCancel: () => void;
}

export default function TaskMoveBlockerDialog({
  decision,
  sourceLabel,
  targetLabel,
  onMoveAnyway,
  onCancel,
}: TaskMoveBlockerDialogProps) {
  const model = buildTaskMoveDialogModel(decision);
  const blockers = Array.isArray(decision.blockers) ? decision.blockers : [];
  const Icon = model.isHardBlocked ? ShieldAlert : AlertTriangle;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <div className="fixed inset-0" onClick={onCancel} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-move-blocker-title"
        className="relative z-10 flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#e5d4bb] bg-[#fcfaf5] shadow-2xl dark:border-[#584a3b] dark:bg-[#1e1914]"
      >
        <div className="flex items-center justify-between border-b border-[#e5d4bb] bg-[#f4ebd9] px-5 py-4 dark:border-[#584a3b] dark:bg-[#292119]">
          <div className="flex items-center gap-2.5">
            <Icon size={17} className="text-[#a46c24] dark:text-[#e0a070]" />
            <div>
              <h2 id="task-move-blocker-title" className="text-sm font-black text-[#4b382b] dark:text-[#f3eadf]">
                {model.isHardBlocked ? 'Task move blocked' : 'Confirm task move'}
              </h2>
              <p className="mt-0.5 text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                {sourceLabel} → {targetLabel}
              </p>
            </div>
          </div>
          <button type="button" onClick={onCancel} aria-label="Close move dialog" className="rounded-full p-1.5 text-[#8a6e5a] hover:bg-white dark:text-[#b8ab9f] dark:hover:bg-[#3a2f26]">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-5 px-5 py-5 text-xs text-[#5c493c] dark:text-[#f3eadf]">
          <section>
            <h3 className="mb-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#a46c24] dark:text-[#e0a070]">What happened</h3>
            <p className="leading-relaxed">{model.summary}</p>
          </section>

          <section>
            <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-[#a46c24] dark:text-[#e0a070]">Why</h3>
            <ul className="space-y-2">
              {blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`} className="rounded-xl border border-[#eadcc6] bg-white/70 px-3 py-2.5 leading-relaxed dark:border-[#4d4033] dark:bg-[#241d17]">
                  {blocker.message}
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-2 text-[10px] font-black uppercase tracking-[0.14em] text-[#a46c24] dark:text-[#e0a070]">What you can do</h3>
            <ul className="list-disc space-y-1.5 pl-4 leading-relaxed">
              {model.actions.map((action) => <li key={action}>{action}</li>)}
            </ul>
          </section>

          <details className="rounded-xl border border-[#eadcc6] px-3 py-2 dark:border-[#4d4033]">
            <summary className="cursor-pointer text-[10px] font-bold uppercase tracking-wide text-[#8a6e5a] dark:text-[#b8ab9f]">Technical details</summary>
            <div className="mt-2 space-y-2 font-mono text-[10px] text-[#776252] dark:text-[#b8ab9f]">
              {blockers.map((blocker, index) => (
                <div key={`${blocker.code}-technical-${index}`}>
                  <div>{blocker.code}</div>
                  {blocker.details !== undefined && <pre className="mt-1 overflow-x-auto whitespace-pre-wrap">{JSON.stringify(blocker.details, null, 2)}</pre>}
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[#e5d4bb] bg-[#f4ebd9] px-5 py-4 dark:border-[#584a3b] dark:bg-[#1e1914]">
          <button type="button" onClick={onCancel} className="rounded-xl border border-[#e5d4bb] bg-white px-4 py-2 text-[10px] font-extrabold uppercase text-[#8a6e5a] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f3eadf]">
            {model.isHardBlocked ? 'Close' : 'Cancel'}
          </button>
          {model.canMoveAnyway && (
            <button type="button" onClick={onMoveAnyway} className="rounded-xl bg-[#d89745] px-4 py-2 text-[10px] font-extrabold uppercase text-white hover:bg-[#c07c28] dark:bg-[#a46c24] dark:hover:bg-[#8a581c]">
              Move Anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
