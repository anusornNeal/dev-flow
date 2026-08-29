import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Copy,
  Palette,
  PawPrint,
  Plus,
} from 'lucide-react';
import type { Task } from '../../types';
import { getDisplayModelName } from '../../lib/agentsConfig';

interface SubtasksSectionProps {
  task: Task;
  subTasks: Task[];
  canCreateSubtask: boolean;
  onCreateSubtask: () => void;
  onSelectTask?: (task: Task) => void;
}

type SubtaskGroupId = 'attention' | 'in-progress' | 'ready' | 'completed';

interface SubtaskGroup {
  id: SubtaskGroupId;
  label: string;
  tasks: Task[];
}

function latestRunStatus(task: Task) {
  const latest = task.latestAgentRun ?? task.agentRuns?.[task.agentRuns.length - 1];
  return latest?.status;
}

function needsAttention(task: Task) {
  const runStatus = latestRunStatus(task);
  return Boolean(task.liveWork?.blocked || runStatus === 'failed' || runStatus === 'timed-out');
}

function statusLabel(task: Task) {
  if (needsAttention(task)) return 'Needs attention';
  if (task.status === 'in-progress') return 'In progress';
  if (task.status === 'done') return 'Completed';
  if (task.status === 'ready-for-review') return 'Ready for review';
  return 'Ready';
}

export default function SubtasksSection({
  task,
  subTasks,
  canCreateSubtask,
  onCreateSubtask,
  onSelectTask,
}: SubtasksSectionProps) {
  const completed = subTasks.filter(subTask => subTask.status === 'done');
  const [showCompleted, setShowCompleted] = useState(completed.length <= 5);

  if (task.parentId) return null;

  const attention = subTasks.filter(subTask => subTask.status !== 'done' && needsAttention(subTask));
  const inProgress = subTasks.filter(subTask => subTask.status === 'in-progress' && !needsAttention(subTask));
  const ready = subTasks.filter(subTask => subTask.status !== 'done' && subTask.status !== 'in-progress' && !needsAttention(subTask));
  const completionPercent = subTasks.length > 0 ? Math.round((completed.length / subTasks.length) * 100) : 0;

  const groups: SubtaskGroup[] = [
    { id: 'attention', label: 'Needs attention', tasks: attention },
    { id: 'in-progress', label: 'In progress', tasks: inProgress },
    { id: 'ready', label: 'Ready / Todo', tasks: ready },
    { id: 'completed', label: 'Completed', tasks: completed },
  ].filter(group => group.tasks.length > 0) as SubtaskGroup[];

  return (
    <section className="space-y-2.5 border-t border-df-border pt-4 font-sans" aria-label="Subtasks">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="flex min-w-0 items-center gap-1.5 text-[12px] font-extrabold text-df-text-strong">
          <PawPrint size={13} className="shrink-0 text-df-accent" />
          <span>Subtasks</span>
        </h4>
        <span className="shrink-0 font-mono text-[10px] font-semibold text-df-text-muted">
          {completed.length}/{subTasks.length} complete
        </span>
        {canCreateSubtask && (
          <button
            type="button"
            onClick={onCreateSubtask}
            className="df-button df-button--primary ml-auto min-h-8 min-w-0 px-2.5 text-[10px]"
          >
            <Plus size={11} /> Create Subtask
          </button>
        )}
      </div>

      {subTasks.length > 0 && (
        <div
          className="h-1 overflow-hidden rounded-full bg-df-surface-muted"
          role="progressbar"
          aria-label={`${completed.length} of ${subTasks.length} subtasks complete`}
          aria-valuemin={0}
          aria-valuemax={subTasks.length}
          aria-valuenow={completed.length}
        >
          <div
            className="h-full rounded-full bg-df-success transition-[width] duration-200"
            style={{ width: `${completionPercent}%` }}
          />
        </div>
      )}

      {subTasks.length === 0 ? (
        <p className="py-2 text-[11px] text-df-text-subtle">No subtasks yet.</p>
      ) : (
        <div className="space-y-2 select-none">
          {groups.map(group => {
            const isCompleted = group.id === 'completed';
            const isCollapsed = isCompleted && !showCompleted;
            return (
              <div key={group.id} data-subtask-group={group.id} className="min-w-0">
                <div className="mb-1 flex min-w-0 items-center gap-2 px-1">
                  <span className="min-w-0 flex-1 truncate text-[9px] font-extrabold uppercase tracking-[0.08em] text-df-text-subtle">
                    {group.label}
                  </span>
                  <span className="shrink-0 font-mono text-[9px] font-bold text-df-text-subtle">{group.tasks.length}</span>
                  {isCompleted && completed.length > 5 && (
                    <button
                      type="button"
                      aria-expanded={showCompleted}
                      onClick={() => setShowCompleted(value => !value)}
                      className="inline-flex min-h-6 shrink-0 items-center gap-1 rounded px-1.5 text-[9px] font-bold text-df-text-muted hover:bg-df-surface-muted hover:text-df-text focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--df-color-focus-ring)]"
                    >
                      {showCompleted ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      {showCompleted ? 'Hide completed' : `Show ${completed.length} completed`}
                    </button>
                  )}
                </div>

                {!isCollapsed && (
                  <div className="overflow-hidden rounded-lg border border-df-border bg-df-surface-raised">
                    {group.tasks.map((subTask, index) => (
                      <SubtaskRow
                        key={subTask.id}
                        task={subTask}
                        onSelectTask={onSelectTask}
                        showDivider={index > 0}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

interface SubtaskRowProps {
  task: Task;
  onSelectTask?: (task: Task) => void;
  showDivider: boolean;
}

function SubtaskRow({ task, onSelectTask, showDivider }: SubtaskRowProps) {
  const displayId = task.displayId || task.id;
  const label = statusLabel(task);
  const attention = needsAttention(task);
  const done = task.status === 'done';
  const active = task.status === 'in-progress' && !attention;
  const selectTask = () => onSelectTask?.(task);
  const owner = task.activeAgent || task.agent;
  const model = task.model ? getDisplayModelName(undefined, task.model) : null;
  const showPriority = task.priority === 'high' || task.priority === 'medium';

  return (
    <div
      role={onSelectTask ? 'button' : undefined}
      tabIndex={onSelectTask ? 0 : undefined}
      aria-label={onSelectTask ? `Open ${displayId}: ${task.title}` : undefined}
      onClick={selectTask}
      onKeyDown={event => {
        if (!onSelectTask || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        selectTask();
      }}
      className={`group relative flex min-h-10 min-w-0 items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-df-surface-muted focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--df-color-focus-ring)] ${
        showDivider ? 'border-t border-df-border' : ''
      } ${done ? 'text-df-text-subtle' : 'text-df-text'} ${onSelectTask ? 'cursor-pointer' : ''}`}
    >
      <span
        aria-label={`Status: ${label}`}
        title={label}
        className={`inline-flex h-5 w-5 shrink-0 items-center justify-center ${
          attention ? 'text-df-danger' : active ? 'text-df-warning' : done ? 'text-df-text-subtle' : 'text-df-text-muted'
        }`}
      >
        {attention ? <AlertTriangle size={13} /> : active ? <CircleDot size={13} /> : done ? <CheckCircle2 size={13} /> : <Circle size={11} />}
      </span>

      <button
        type="button"
        onClick={event => {
          event.stopPropagation();
          void navigator.clipboard.writeText(displayId);
        }}
        className="inline-flex max-w-[92px] shrink-0 items-center gap-1 rounded px-1 py-0.5 font-mono text-[9.5px] font-bold text-df-accent hover:bg-df-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--df-color-focus-ring)]"
        title={`Copy ${displayId}`}
        aria-label={`Copy task ID ${displayId}`}
      >
        <span className="truncate">{displayId}</span>
        <Copy size={9} className="shrink-0 opacity-0 transition-opacity group-hover:opacity-70 group-focus-within:opacity-70" />
      </button>

      <span className={`min-w-0 flex-1 truncate text-[12px] leading-5 ${done ? 'text-df-text-subtle' : 'font-semibold text-df-text-strong'}`} title={task.title}>
        {task.title}
      </span>

      <div className="flex min-w-0 shrink items-center justify-end gap-1.5 text-[9px] font-semibold text-df-text-muted">
        {attention && <span className="shrink-0 text-df-danger">Blocked</span>}
        {showPriority && (
          <span className={`shrink-0 ${task.priority === 'high' ? 'text-df-danger' : 'text-df-warning'}`}>
            {task.priority === 'high' ? 'High' : 'Medium'}
          </span>
        )}
        {!done && owner && <span className="max-w-[78px] truncate" title={owner}>{owner}</span>}
        {!done && !owner && model && <span className="max-w-[110px] truncate" title={model}>{model}</span>}
        {task.hasUiDesign && (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-df-info" title="Task has UI Design">
            <Palette size={10} /><span>Design</span>
          </span>
        )}
      </div>
    </div>
  );
}
