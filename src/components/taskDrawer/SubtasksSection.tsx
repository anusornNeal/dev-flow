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
    <div className="space-y-3 border-t border-[#ebdcb9] pt-4 font-sans dark:border-[#584a3b]">
      <div className="flex items-center justify-between gap-3">
        <h4 className="flex items-center gap-1.5 text-[10px] font-bold font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf]">
          <PawPrint size={13} className="text-[#d89745] dark:text-[#d6b56d]" /> Subtasks Breakdown ({completedSubtasks}/{subTasks.length})
        </h4>
        {canCreateSubtask && (
          <button
            type="button"
            onClick={onCreateSubtask}
            className="flex cursor-pointer items-center gap-1 rounded-xl bg-[#2a7a8a] px-3 py-1.5 text-[10px] font-extrabold tracking-wide text-white shadow-4xs transition-all hover:bg-[#1a5b67] active:scale-[0.98] dark:bg-[#e0a070] dark:text-[#292119] dark:hover:bg-[#d6b56d]"
          >
            <Plus size={11} /> Create Subtask Spec
          </button>
        )}
      </div>

      {subTasks.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center gap-3 rounded-xl border border-[#ebdcb9]/65 bg-white px-2.5 py-2 shadow-3xs dark:border-[#584a3b]/65 dark:bg-[#292119]">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[#ede6dc]/60 dark:bg-[#3a2f26]">
              <div
                className="h-full rounded-full bg-[#2a7a8a] transition-all duration-300 dark:bg-[#e0a070]"
                style={{ width: `${completionPercent}%` }}
              />
            </div>
            <span className="shrink-0 text-[9px] font-black font-mono text-[#2a7a8a] dark:text-[#f3eadf]">
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

  return (
    <div
      onClick={() => {
        if (onSelectTask) onSelectTask(task);
      }}
      className={`relative flex cursor-pointer flex-col gap-2 rounded-xl border px-2.5 py-2 transition-all hover:bg-[#fffcf8] hover:shadow-sm active:scale-[0.98] dark:hover:bg-[#1e1914] ${
        subDone
          ? 'border-emerald-100/60 bg-[#edf7ed]/20 text-gray-400 dark:border-[#584a3b]/65 dark:bg-[#292119]/55 dark:text-[#b8ab9f]'
          : subInProgress
            ? 'border-[#e3a35a] bg-white shadow-2xs dark:border-[#e0a070]/70 dark:bg-[#292119]'
            : 'border-[#ebdcb9]/65 bg-white text-[#3a2f26] dark:border-[#584a3b]/65 dark:bg-[#292119] dark:text-[#f3eadf]'
      }`}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            navigator.clipboard.writeText(displayId);
          }}
          className="inline-flex shrink-0 cursor-pointer items-center rounded-md bg-[#f4eadc] px-1.5 py-0.5 text-[9px] font-black font-mono text-[#8a6020] hover:text-[#d89745] dark:bg-[#3a2f26] dark:text-[#e0a070]"
          title="Copy Card ID"
        >
          {displayId}
        </button>
        <span className={`shrink-0 rounded-md border px-1.5 py-0.5 text-[9px] font-extrabold font-mono uppercase ${
          subDone
            ? 'border-emerald-200/60 bg-emerald-50 text-emerald-700 dark:border-emerald-800/50 dark:bg-emerald-950/20 dark:text-emerald-300'
            : subInProgress
              ? 'border-orange-200/70 bg-orange-50 text-orange-700 dark:border-orange-800/50 dark:bg-orange-950/20 dark:text-orange-300'
              : 'border-[#ebdcb9] bg-[#fffaf2] text-[#8a6e5a] dark:border-[#584a3b] dark:bg-[#3a2f26] dark:text-[#b8ab9f]'
        }`}>
          {statusLabel}
        </span>
      </div>

      <p className={`line-clamp-2 min-w-0 text-[11px] font-extrabold leading-[1.35] ${
        subDone
          ? 'font-normal text-gray-400 line-through dark:text-[#b8ab9f]'
          : 'text-[#3e3129] dark:text-[#f3eadf]'
      }`}>
        {task.title}
      </p>

      <div className="flex min-h-4 items-center gap-1 font-mono text-[9px] font-bold">
        <span className={`rounded-md border px-1.5 py-0.5 uppercase ${
          task.priority === 'high'
            ? 'border-[#ffa995] bg-[#ffdacf] text-[#b43a20] dark:border-[#8c4938] dark:bg-[#3a2f26] dark:text-[#f3b39e]'
            : task.priority === 'medium'
              ? 'border-[#f0cca3] bg-[#ffecca] text-[#a46c24] dark:border-[#765c3f] dark:bg-[#3a2f26] dark:text-[#efc483]'
              : 'border-[#bddda4] bg-[#e2f0dc] text-[#4d7e35] dark:border-[#4f6844] dark:bg-[#3a2f26] dark:text-[#b8d8a8]'
        }`}>
          {task.priority}
        </span>
        {task.hasUiDesign && (
          <span className="rounded-md border border-[#c9b6f4] bg-[#f2edff] px-1.5 py-0.5 text-[#6848a8] dark:border-[#66528f] dark:bg-[#332a42] dark:text-[#d2c4f4]">
            DESIGN
          </span>
        )}
      </div>
    </div>
  );
}
