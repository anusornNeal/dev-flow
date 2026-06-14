import React from 'react';
import type { Task, TaskStatus } from '../types';
import TaskCard from './TaskCard';
import { ListTodo, Code, GitMerge, FileText } from 'lucide-react';
import { isValidTransition } from '../lib/statusTransitions';

interface ColumnDef {
  id: TaskStatus;
  label: string;
  iconName: string;
}

interface BoardLaneProps {
  column: ColumnDef;
  tasks: Task[];
  allTasks: Task[];
  draggedOverColumn: TaskStatus | null;
  draggedTaskId: string | null;
  setDraggedOverColumn: (status: TaskStatus | null) => void;
  handleDrop: (e: React.DragEvent, status: TaskStatus) => void;
  setSelectedTask: (task: Task | null) => void;
  handleDeleteTask: (id: string) => void;
  handleDragStart: (e: React.DragEvent, taskId: string) => void;
  handleUpdateTask: (updatedTask: Task) => Promise<void>;
  onShowLog?: (args: { taskDisplayId: string; run: { id: string; status?: string; agent?: string | null; model?: string | null } }) => void;
}

export function BoardLane({
  column,
  tasks,
  allTasks,
  draggedOverColumn,
  draggedTaskId,
  setDraggedOverColumn,
  handleDrop,
  setSelectedTask,
  handleDeleteTask,
  handleDragStart,
  handleUpdateTask,
  onShowLog
}: BoardLaneProps) {
  const getColIcon = (name: string) => {
    switch (name) {
      case 'ListTodo': return <ListTodo size={14} className="opacity-80" />;
      case 'Code': return <Code size={14} className="opacity-80" />;
      case 'GitMerge': return <GitMerge size={14} className="opacity-80" />;
      case 'FileText': return <FileText size={14} className="opacity-80" />;
      default: return <ListTodo size={14} className="opacity-80" />;
    }
  };

  const totalStepsInLane = tasks.reduce((sum, t) => sum + (t.checklist?.length || 0), 0);
  const completedStepsInLane = tasks.reduce((sum, t) => sum + (t.checklist?.filter(item => item.completed).length || 0), 0);
  const isOver = draggedOverColumn === column.id;
  const draggedTask = draggedTaskId ? allTasks.find(t => t.id === draggedTaskId) : null;
  const isDraggingAny = draggedTaskId !== null;
  // It's a valid drop if there's no drag, OR if there's a drag and the transition is valid
  // (We also treat dragging a task to its current lane as valid for visual purposes)
  const isValidDrop = !isDraggingAny || !draggedTask || column.id === draggedTask.status || isValidTransition(draggedTask.status, column.id);
  
  const isInProgressCol = column.id === 'in-progress';
  const isReviewCol = column.id === 'ready-for-review';
  const isDoneCol = column.id === 'done';

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (draggedOverColumn !== column.id) {
          setDraggedOverColumn(column.id);
        }
        if (!isValidDrop) {
          e.dataTransfer.dropEffect = 'none';
        }
      }}
      onDragLeave={() => {
        if (draggedOverColumn === column.id) {
          setDraggedOverColumn(null);
        }
      }}
      onDrop={(e) => handleDrop(e, column.id)}
      className={`w-[300px] shrink-0 flex flex-col pb-4 p-2 transition-all border-r border-[#e5d4bb]/30 dark:border-[#584a3b]/30 ${
        isDraggingAny && !isValidDrop ? 'opacity-40 grayscale-[0.5]' : ''
      } ${
        isOver 
          ? isValidDrop 
            ? 'bg-[#ffeccb]/20 dark:bg-[#292119]/40 border-dashed border-[#e3a35a] dark:border-[#584a3b] rounded-2xl' 
            : 'bg-red-50/50 dark:bg-red-950/20 border-dashed border-red-400/60 dark:border-red-900/50 rounded-2xl cursor-not-allowed'
          : ''
      }`}
    >
      {/* Status header lane metadata */}
      <div className="flex items-center justify-between mb-4 px-3 pt-3 select-none">
        <div className="flex items-center gap-2">
          <span className={`shrink-0 ${
            isInProgressCol ? 'text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]' : 
            isReviewCol ? 'text-[#3b5eab] dark:text-[#8ba4e8]' : 
            isDoneCol ? 'text-[#5fa84a] dark:text-[#8fce7c]' : 
            'text-[#8a725f] dark:text-[#b8ab9f]'
          }`}>
            {getColIcon(column.iconName)}
          </span>
          
          <h3 className={`text-[11px] font-bold uppercase tracking-widest font-mono ${
            isInProgressCol ? 'text-[#8f5e1f] dark:text-[#f3eadf]' : 
            isReviewCol ? 'text-[#2b3a61] dark:text-[#f3eadf]' : 
            isDoneCol ? 'text-[#38622c] dark:text-[#f3eadf]' : 
            'text-[#614e41] dark:text-[#f3eadf]'
          }`}>
            {column.label}
          </h3>
          
          <span className="text-[10px] font-mono px-2 py-0.5 rounded-md font-bold text-[#8f7d6e] dark:text-[#887a6c] bg-[#f5ebd6] dark:bg-[#292119]">
            {tasks.length}
          </span>
        </div>

        {totalStepsInLane > 0 && (
          <span className="text-[9px] font-mono text-[#a48e7e] dark:text-[#887a6c] uppercase tracking-wider font-bold">
            {completedStepsInLane}/{totalStepsInLane}
          </span>
        )}
      </div>

      <div className="flex-1 flex flex-col gap-3 p-1 overflow-y-auto scrollbar-thin transition-all px-2">
        {tasks.map(task => {
          const subtasks = allTasks.filter(t => t.parentId === task.id);
          return (
            <TaskCard
              key={task.id}
              task={task}
              subtasks={subtasks}
              onSelect={setSelectedTask}
              onDelete={handleDeleteTask}
              onDragStart={handleDragStart}
              onUpdate={handleUpdateTask}
              onShowLog={onShowLog ? (run) => onShowLog({ taskDisplayId: task.displayId || task.id, run }) : undefined}
            />
          );
        })}

        {tasks.length === 0 && (
          <div className="flex flex-col items-center justify-center h-24 text-[#bcaea3] dark:text-[#6a5e54] border-2 border-dashed border-[#eaddc6] dark:border-[#382f25] rounded-xl bg-white/40 dark:bg-black/10 mt-2">
            <span className="text-[10px] font-mono font-medium tracking-wide">Drop card here</span>
          </div>
        )}
      </div>
    </div>
  );
}
