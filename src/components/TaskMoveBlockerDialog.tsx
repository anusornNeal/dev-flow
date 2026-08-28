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
  const stateLabel = model.isHardBlocked ? 'Safety blocker' : 'Workflow check';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--df-color-backdrop)] p-3 backdrop-blur-xs sm:p-4">
      <div className="fixed inset-0" onClick={onCancel} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-move-blocker-title"
        aria-describedby="task-move-blocker-summary"
        className="relative z-10 flex max-h-[calc(100vh-1.5rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-df-border bg-df-surface shadow-[var(--df-shadow-lg)] sm:max-h-[calc(100vh-2rem)]"
      >
        <div className={`shrink-0 border-b px-5 py-4 ${
          model.isHardBlocked
            ? 'border-df-danger bg-[var(--df-color-danger-surface)]'
            : 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
        }`}>
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-3">
              <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                model.isHardBlocked ? 'bg-df-danger text-white' : 'bg-[var(--df-color-warning)] text-white'
              }`}>
                <Icon size={16} />
              </span>
              <div className="min-w-0">
                <p className={`text-[9px] font-black uppercase tracking-[0.16em] ${model.isHardBlocked ? 'text-df-danger' : 'text-[var(--df-color-warning)]'}`}>
                  {stateLabel}
                </p>
                <h2 id="task-move-blocker-title" className="mt-1 text-sm font-black text-df-text">
                  {model.isHardBlocked ? 'Task move blocked' : 'Review before moving'}
                </h2>
                <p className="mt-1 truncate text-[9px] font-mono text-df-text-muted" title={`${sourceLabel} → ${targetLabel}`}>
                  {sourceLabel} → {targetLabel}
                </p>
              </div>
            </div>
            <button type="button" onClick={onCancel} aria-label="Close move dialog" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-df-text-muted hover:bg-df-surface-raised/70 hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5 text-xs text-df-text scrollbar-thin">
          <section>
            <h3 className="text-[9px] font-black uppercase tracking-[0.14em] text-df-text-muted">What happened</h3>
            <p id="task-move-blocker-summary" className="mt-1.5 break-words text-[12px] font-extrabold leading-relaxed text-df-text">
              {model.summary}
            </p>
          </section>

          <section className={`rounded-xl border p-3 ${
            model.isHardBlocked
              ? 'border-df-danger bg-[var(--df-color-danger-surface)]'
              : 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
          }`}>
            <h3 className="text-[9px] font-black uppercase tracking-[0.14em] text-df-text-muted">What you can do</h3>
            <ul className="mt-2 list-disc space-y-1.5 pl-4 text-[10px] font-semibold leading-relaxed text-df-text">
              {model.actions.map((action) => <li key={action} className="break-words">{action}</li>)}
            </ul>
          </section>

          <section>
            <h3 className="text-[9px] font-black uppercase tracking-[0.14em] text-df-text-muted">Why</h3>
            <ul className="mt-2 space-y-2">
              {blockers.map((blocker, index) => (
                <li key={`${blocker.code}-${index}`} className="break-words rounded-xl border border-df-border bg-df-surface-raised px-3 py-2.5 text-[10px] font-semibold leading-relaxed text-df-text">
                  {blocker.message}
                </li>
              ))}
            </ul>
          </section>

          <details className="rounded-xl border border-df-border bg-df-surface-muted px-3 py-2.5">
            <summary className="cursor-pointer text-[9px] font-black uppercase tracking-[0.12em] text-df-text-muted">Technical details</summary>
            <div className="mt-2 max-h-44 space-y-3 overflow-auto break-words font-mono text-[9px] leading-relaxed text-df-text-muted">
              {decision.code && (
                <div>
                  <div className="font-bold text-df-text">Decision</div>
                  <div className="mt-0.5 break-all">{decision.code}</div>
                </div>
              )}
              {blockers.map((blocker, index) => (
                <div key={`${blocker.code}-technical-${index}`} className="min-w-0">
                  <div className="break-all font-bold text-df-text">{blocker.code}</div>
                  {blocker.details !== undefined && (
                    <pre className="mt-1 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-lg bg-df-surface-raised p-2">{JSON.stringify(blocker.details, null, 2)}</pre>
                  )}
                </div>
              ))}
            </div>
          </details>
        </div>

        <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-df-border bg-df-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
          <button type="button" onClick={onCancel} className={`h-10 rounded-xl px-4 text-[10px] font-extrabold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)] ${
            model.isHardBlocked
              ? 'bg-df-primary text-[var(--df-color-primary-text)] hover:bg-[var(--df-color-primary-hover)]'
              : 'border border-df-border text-df-text-muted hover:bg-df-surface-muted'
          }`}>
            {model.isHardBlocked ? 'Close' : 'Cancel'}
          </button>
          {model.canMoveAnyway && (
            <button type="button" onClick={onMoveAnyway} className="h-10 rounded-xl bg-[var(--df-color-warning)] px-4 text-[10px] font-extrabold text-white shadow-[var(--df-shadow-sm)] hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              Move Anyway
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
