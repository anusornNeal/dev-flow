import React from 'react';
import type { Task, TaskStatus } from '../types';
import TaskCard from './TaskCard';
import { Code, FileText, GitMerge, GitPullRequest, ListTodo, Moon, Terminal } from 'lucide-react';
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
  totalCount?: number;
  loadedCount?: number;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
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

function getColIcon(name: string) {
  switch (name) {
    case 'Moon': return <Moon size={14} className="opacity-80" />;
    case 'ListTodo': return <ListTodo size={14} className="opacity-80" />;
    case 'Code': return <Code size={14} className="opacity-80" />;
    case 'Terminal': return <Terminal size={14} className="opacity-80" />;
    case 'GitMerge': return <GitMerge size={14} className="opacity-80" />;
    case 'GitPullRequest': return <GitPullRequest size={14} className="opacity-80" />;
    case 'FileText': return <FileText size={14} className="opacity-80" />;
    default: return <ListTodo size={14} className="opacity-80" />;
  }
}

export function BoardLane({
  column,
  tasks,
  allTasks,
  totalCount = tasks.length,
  loadedCount = tasks.length,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  draggedOverColumn,
  draggedTaskId,
  setDraggedOverColumn,
  handleDrop,
  setSelectedTask,
  handleDeleteTask,
  handleDragStart,
  handleUpdateTask,
  onShowLog,
}: BoardLaneProps) {
  const totalStepsInLane = tasks.reduce((sum, task) => sum + (task.checklist?.length || 0), 0);
  const completedStepsInLane = tasks.reduce((sum, task) => sum + (task.checklist?.filter(item => item.completed).length || 0), 0);
  const isOver = draggedOverColumn === column.id;
  const draggedTask = draggedTaskId ? allTasks.find(task => task.id === draggedTaskId) : null;
  const isDraggingAny = draggedTaskId !== null;
  const isValidDrop = !isDraggingAny || !draggedTask || column.id === draggedTask.status || isValidTransition(draggedTask.status, column.id);
  const dropStateLabel = !isDraggingAny ? null : isValidDrop ? 'Drop allowed' : 'Move blocked';
  const laneCountLabel = hasMore ? `${loadedCount} of ${totalCount}` : `${totalCount}`;

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (draggedOverColumn !== column.id) setDraggedOverColumn(column.id);
        if (!isValidDrop) e.dataTransfer.dropEffect = 'none';
      }}
      onDragLeave={() => {
        if (draggedOverColumn === column.id) setDraggedOverColumn(null);
      }}
      onDrop={(e) => handleDrop(e, column.id)}
      className={`flex min-w-0 flex-col overflow-hidden border-r border-[var(--df-color-border)] px-3 pb-3 pt-2.5 transition-[background-color,border-color,opacity] ${
        isDraggingAny && !isValidDrop ? 'opacity-55' : ''
      } ${
        isOver
          ? isValidDrop
            ? 'rounded-[var(--df-radius-lg)] border border-dashed border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
            : 'cursor-not-allowed rounded-[var(--df-radius-lg)] border border-dashed border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
          : ''
      }`}
      aria-label={`${column.label} lane${isOver && dropStateLabel ? `, ${dropStateLabel.toLowerCase()}` : ''}`}
      data-drop-valid={isDraggingAny ? String(isValidDrop) : undefined}
    >
      <div className="mb-2 flex min-w-0 flex-col gap-1 select-none">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-[var(--df-color-text-muted)]">
            {getColIcon(column.iconName)}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--df-color-text-strong)]" title={column.label}>
            {column.label}
          </h3>
          <span className="shrink-0 rounded-md bg-[var(--df-color-surface-muted)] px-2 py-0.5 text-[10px] font-bold text-[var(--df-color-text-muted)]" aria-label={`${laneCountLabel} tasks loaded`}>
            {laneCountLabel}
          </span>
        </div>

        {(totalStepsInLane > 0 || (isOver && dropStateLabel)) && (
          <div className="flex min-w-0 items-center justify-between gap-2 text-[9px] font-semibold text-[var(--df-color-text-subtle)]">
            {totalStepsInLane > 0 ? (
              <span className="min-w-0 truncate" title={`Checklist ${completedStepsInLane} of ${totalStepsInLane}`}>
                Checklist {completedStepsInLane}/{totalStepsInLane}
              </span>
            ) : <span />}
            {isOver && dropStateLabel && (
              <span
                className={`shrink-0 font-extrabold ${isValidDrop ? 'text-[var(--df-color-warning)]' : 'text-[var(--df-color-danger)]'}`}
                aria-live="polite"
              >
                {dropStateLabel}
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto scrollbar-thin">
        {tasks.map(task => {
          const subtasks = allTasks.filter(candidate => candidate.parentId === task.id);
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

        {hasMore && onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            className="mt-1 min-h-8 w-full rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-3 py-2 text-[10px] font-bold text-[var(--df-color-text-muted)] transition-colors hover:border-[var(--df-color-border-strong)] hover:bg-[var(--df-color-surface-subtle)] disabled:cursor-wait disabled:opacity-60"
          >
            {loadingMore ? 'Loading…' : `Load more · ${loadedCount} of ${totalCount}`}
          </button>
        )}

        {tasks.length === 0 && (
          <div className={`mt-1 flex min-h-[56px] min-w-0 flex-col items-center justify-center rounded-[var(--df-radius-md)] border-2 border-dashed px-3 text-center ${
            isDraggingAny && !isValidDrop
              ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] text-[var(--df-color-danger)]'
              : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] text-[var(--df-color-text-subtle)]'
          }`}>
            <span className="text-[10px] font-semibold tracking-wide">
              {isDraggingAny && !isValidDrop ? 'Cannot drop here' : 'Drop card here'}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
