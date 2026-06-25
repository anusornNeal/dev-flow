import { PawPrint, Plus } from 'lucide-react';
import type { Task } from '../../types';

interface SubtasksSectionProps {
  task: Task;
  subTasks: Task[];
  showAllSubtasks: boolean;
  canCreateSubtask: boolean;
  onCreateSubtask: () => void;
  onSelectTask?: (task: Task) => void;
  onShowAllSubtasksChange: (value: boolean) => void;
}

export default function SubtasksSection({
  task,
  subTasks,
  showAllSubtasks,
  canCreateSubtask,
  onCreateSubtask,
  onSelectTask,
  onShowAllSubtasksChange,
}: SubtasksSectionProps) {
  if (task.parentId) return null;

  const completedSubtasks = subTasks.filter(subTask => subTask.status === 'done').length;
  const completionPercent = subTasks.length > 0 ? Math.round((completedSubtasks / subTasks.length) * 100) : 0;
  const visibleSubtasks = showAllSubtasks ? subTasks : subTasks.slice(0, 4);

  return (
    <div className="space-y-3.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5 font-sans">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
          <PawPrint size={13} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Subtasks Breakdown ({completedSubtasks}/{subTasks.length})
        </h4>
        {canCreateSubtask && (
          <button
            type="button"
            onClick={onCreateSubtask}
            className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] hover:bg-[#1a5b67] dark:bg-[#3c829e] dark:hover:bg-[#292119] text-[10px] font-extrabold px-3 py-1.5 rounded-xl flex items-center gap-1 transition-all cursor-pointer shadow-4xs font-sans tracking-wide active:scale-[0.98]"
          >
            <Plus size={11} /> Create Subtask Spec
          </button>
        )}
      </div>

      {subTasks.length > 0 && (
        <div className="space-y-2.5">
          <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9]/65 dark:border-[#584a3b]/65 p-3 rounded-2xl flex items-center justify-between gap-4 shadow-3xs">
            <div className="flex-1 bg-[#ede6dc]/60 dark:bg-[#292119]/60 rounded-full h-1.5 overflow-hidden">
              <div
                className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] h-full rounded-full transition-all duration-300"
                style={{ width: `${completionPercent}%` }}
              />
            </div>
            <span className="text-[10px] font-mono font-black text-[#2a7a8a] dark:text-[#f3eadf]">
              {completionPercent}% complete
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 select-none">
            {visibleSubtasks.map(subTask => (
              <SubtaskCard key={subTask.id} task={subTask} onSelectTask={onSelectTask} />
            ))}
          </div>

          {subTasks.length > 4 && !showAllSubtasks && (
            <button
              type="button"
              onClick={() => onShowAllSubtasksChange(true)}
              className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
            >
              show {subTasks.length - 4} more ↓
            </button>
          )}
          {subTasks.length > 4 && showAllSubtasks && (
            <button
              type="button"
              onClick={() => onShowAllSubtasksChange(false)}
              className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
            >
              show less ↑
            </button>
          )}
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

  return (
    <div
      onClick={() => {
        if (onSelectTask) onSelectTask(task);
      }}
      className={`p-3.5 rounded-2xl border flex flex-col justify-between h-[90px] cursor-pointer transition-all hover:bg-[#fffcf8] dark:bg-[#292119] dark:hover:bg-[#1e1914] active:scale-[0.98] hover:shadow-sm relative ${
        subDone
          ? 'bg-[#edf7ed]/30 dark:bg-[#292119]/30 border-emerald-100/50 text-gray-400 dark:text-[#b8ab9f]'
          : subInProgress
            ? 'bg-orange-50/15 border-[#e3a35a] dark:border-[#584a3b] shadow-2xs'
            : 'bg-white dark:bg-[#292119] border-[#ebdcb9]/65 dark:border-[#584a3b]/65 text-[#3a2f26] dark:text-[#f3eadf]'
      }`}
    >
      <div className="space-y-1 min-w-0 pr-1">
        <p className={`text-[11px] font-extrabold leading-snug truncate ${subDone ? 'line-through text-gray-400 dark:text-[#b8ab9f] font-normal' : 'text-[#3e3129] dark:text-[#f3eadf]'}`}>
          {task.title}
        </p>
        <button
          type="button"
          onClick={event => {
            event.stopPropagation();
            const idToCopy = task.displayId || task.id;
            navigator.clipboard.writeText(idToCopy);
          }}
          className="flex items-center gap-1 text-[9px] font-mono text-gray-400 dark:text-[#b8ab9f]/80 hover:text-[#d89745] dark:text-[#d6b56d] dark:hover:text-[#e0a070] dark:text-[#d6b56d] font-bold cursor-pointer"
          title="Copy Card ID"
        >
          ID: #{task.displayId || task.id}
        </button>
      </div>

      <div className="flex items-center justify-between select-none font-mono text-[7.5px] font-bold">
        <div className="flex items-center gap-1">
          {task.model && (
            <span className="px-1 py-0.2 rounded border bg-[#fae8ff] dark:bg-[#292119] text-[#86198f] dark:text-[#f3eadf] border-[#f5d0fe] dark:border-[#584a3b]">
              {task.model}
            </span>
          )}
          <span className={`px-1 py-0.2 rounded border uppercase ${
            task.priority === 'high' ? 'bg-[#ffdacf] dark:bg-[#292119] text-[#b43a20] dark:text-[#f3eadf] border-[#ffa995] dark:border-[#584a3b]' :
            task.priority === 'medium' ? 'bg-[#ffecca] dark:bg-[#292119] text-[#a46c24] dark:text-[#f3eadf] border-[#f0cca3] dark:border-[#584a3b]' :
            'bg-[#e2f0dc] dark:bg-[#292119] text-[#4d7e35] dark:text-[#f3eadf] border-[#bddda4] dark:border-[#584a3b]'
          }`}>
            {task.priority}
          </span>
        </div>

        <span className={`px-1.5 py-0.4 rounded-lg border uppercase font-extrabold ${
          subDone ? 'bg-emerald-50 text-emerald-700 border-[#bddda4]/50 dark:border-[#584a3b]/50' :
          subInProgress ? 'bg-orange-50 text-orange-700 border-orange-200/50' :
          'bg-white dark:bg-[#292119] text-gray-400 dark:text-[#b8ab9f] border-gray-350'
        }`}>
          {task.status === 'in-progress' ? 'active' : task.status}
        </span>
      </div>
    </div>
  );
}
