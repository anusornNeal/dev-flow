import { PawPrint, Plus } from 'lucide-react';
import type { Task } from '../../types';

interface SubtasksSectionProps {
  task: Task;
  subTasks: Task[];
  canCreateSubtask: boolean;
  onCreateSubtask: () => void;
  onSelectTask?: (task: Task) => void;
}

export default function SubtasksSection({
  task,
  subTasks,
  canCreateSubtask,
  onCreateSubtask,
  onSelectTask,
}: SubtasksSectionProps) {
  if (task.parentId) return null;

  const completedSubtasks = subTasks.filter(subTask => subTask.status === 'done').length;
  const completionPercent = subTasks.length > 0 ? Math.round((completedSubtasks / subTasks.length) * 100) : 0;

  return (
    <div className="space-y-3 border-t border-df-border pt-4 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h4 className="flex min-w-0 items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-df-text-muted">
          <PawPrint size={13} className="shrink-0 text-df-accent" /> Subtasks Breakdown ({completedSubtasks}/{subTasks.length})
        </h4>
        {canCreateSubtask && (
          <button
            type="button"
            onClick={onCreateSubtask}
            className="df-button df-button--primary min-h-8 min-w-0 px-3 text-[10px]"
          >
            <Plus size={11} /> Create Subtask Spec
          </button>
        )}
      </div>

      {subTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-xl border border-df-border bg-df-surface-raised px-2.5 py-2 shadow-[var(--df-shadow-sm)]">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-df-surface-muted" aria-hidden="true">
              <div
                className="h-full rounded-full bg-df-success transition-all duration-300"
                style={{ width: `${completionPercent}%` }}
              />
            </div>
            <span className="shrink-0 font-mono text-[10px] font-black text-df-success">
              {completionPercent}% complete
            </span>
          </div>

          <div className="grid grid-cols-1 gap-2.5 select-none sm:grid-cols-2">
            {subTasks.map(subTask => (
              <SubtaskCard key={subTask.id} task={subTask} onSelectTask={onSelectTask} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface SubtaskCardProps {
  task: Task;
  onSelectTask?: (task: Task) => void;
}

function SubtaskCard({ task, onSelectTask }: SubtaskCardProps) {
  const subDone = task.status === 'done';
  const subInProgress = task.status === 'in-progress';
  const displayId = task.displayId || task.id;
  const statusLabel = subInProgress ? 'active' : task.status;
  const selectTask = () => onSelectTask?.(task);

  const statusClass = subDone
    ? 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)] text-df-success'
    : subInProgress
      ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] text-df-warning'
      : 'border-df-border bg-df-surface-muted text-df-text-muted';

  const priorityClass = task.priority === 'high'
    ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] text-df-danger'
    : task.priority === 'medium'
      ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] text-df-warning'
      : 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)] text-df-success';

  return (
    <div
      role={onSelectTask ? 'button' : undefined}
      tabIndex={onSelectTask ? 0 : undefined}
      aria-label={onSelectTask ? `Open ${displayId}: ${task.title}` : undefined}
      onClick={selectTask}
      onKeyDown={(event) => {
        if (!onSelectTask || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectTask();
      }}
      className={`relative flex min-w-0 flex-col gap-2 rounded-xl border px-2.5 py-2 transition-all hover:bg-df-surface-muted hover:shadow-[var(--df-shadow-sm)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-color-focus-ring)] ${
        subDone
          ? 'border-df-border bg-[var(--df-color-success-surface)] text-df-text-muted'
          : subInProgress
            ? 'border-[var(--df-color-accent)] bg-df-surface-raised shadow-[var(--df-shadow-sm)]'
            : 'border-df-border bg-df-surface-raised text-df-text'
      } ${onSelectTask ? 'cursor-pointer' : ''}`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            void navigator.clipboard.writeText(displayId);
          }}
          className="inline-flex max-w-[55%] shrink-0 items-center truncate rounded-md bg-df-surface-muted px-1.5 py-0.5 font-mono text-[10px] font-black text-df-accent hover:text-[var(--df-color-accent-hover)]"
          title={`Copy ${displayId}`}
          aria-label={`Copy task ID ${displayId}`}
        >
          {displayId}
        </button>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-extrabold uppercase ${statusClass}`}>
          {statusLabel}
        </span>
      </div>

      <p className={`line-clamp-2 min-w-0 break-words text-[11px] font-extrabold leading-[1.35] ${
        subDone ? 'font-normal text-[var(--df-color-text-subtle)] line-through' : 'text-[var(--df-color-text-strong)]'
      }`}>
        {task.title}
      </p>

      <div className="flex min-h-4 min-w-0 flex-wrap items-center gap-1 font-mono text-[10px] font-bold">
        <span className={`rounded-md border px-1.5 py-0.5 uppercase ${priorityClass}`}>
          {task.priority}
        </span>
        {task.hasUiDesign && (
          <span className="rounded-md border border-[var(--df-color-info)] bg-[var(--df-color-info-surface)] px-1.5 py-0.5 text-df-info">
            DESIGN
          </span>
        )}
      </div>
    </div>
  );
}
