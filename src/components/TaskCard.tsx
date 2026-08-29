/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckSquare,
  CircleCheck,
  Coffee,
  FileCode,
  Flame,
  Image as ImageIcon,
  Layout,
  Link as LinkIcon,
  Server,
  Trash2,
} from 'lucide-react';
import type { Task } from '../types';
import CopyTemplateButton from './CopyTemplateButton';

interface TaskCardProps {
  key?: string;
  task: Task;
  subtasks?: Task[];
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onUpdate?: (updatedTask: Task) => void;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

function taskCategoryBadge(task: Task) {
  if (task.category === 'frontend') {
    return (
      <span className="inline-flex max-w-[92px] shrink-0 items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--df-color-text-muted)]" title="Frontend">
        <Layout size={9} />
        <span className="truncate">Frontend</span>
      </span>
    );
  }
  if (task.category === 'backend') {
    return (
      <span className="inline-flex max-w-[92px] shrink-0 items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--df-color-text-muted)]" title="Backend">
        <Server size={9} />
        <span className="truncate">Backend</span>
      </span>
    );
  }
  return null;
}

export default function TaskCard({ task, subtasks = [], onSelect, onDelete, onDragStart, onUpdate }: TaskCardProps) {
  const [idCopied, setIdCopied] = useState(false);
  const [isDrag, setIsDrag] = useState(false);

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idToCopy = task.displayId || task.id;
    if (!idToCopy) return;
    navigator.clipboard.writeText(idToCopy);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 2000);
  };

  const isDone = task.status === 'done';
  const isInProgress = task.status === 'in-progress';
  const formattedDate = new Date(task.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  const totalSteps = task.checklist?.length || 0;
  const completedSteps = task.checklist?.filter(item => item.completed).length || 0;
  const filesCount = task.targetFiles?.length || 0;
  const unresolvedBugCount = task.unresolvedBugCount ?? (task.bugs || []).filter((bug) => ['open', 'fixing', 'fixed', 'reopened'].includes(bug.status)).length;
  const liveWork = task.liveWork;
  const liveWorkAgeMs = liveWork?.updatedAt ? Math.max(0, Date.now() - Date.parse(liveWork.updatedAt)) : null;
  const liveWorkFreshness = liveWorkAgeMs == null || !Number.isFinite(liveWorkAgeMs)
    ? null
    : liveWorkAgeMs < 60_000
      ? 'now'
      : liveWorkAgeMs < 60 * 60_000
        ? `${Math.floor(liveWorkAgeMs / 60_000)}m`
        : `${Math.floor(liveWorkAgeMs / (60 * 60_000))}h`;

  const priorityLabel = task.priority === 'high' ? 'High' : task.priority === 'low' ? 'Low' : 'Medium';
  const priorityTone = task.priority === 'high'
    ? 'text-[var(--df-color-danger)]'
    : task.priority === 'low'
      ? 'text-[var(--df-color-text-subtle)]'
      : 'text-[var(--df-color-text-muted)]';
  const taskIdentity = task.displayId || task.id;
  const completedSubtasks = subtasks.filter((subtask) => subtask.status === 'done').length;
  const unfinishedSubtasks = subtasks.filter((subtask) => subtask.status !== 'done');
  const subtaskRank = (subtask: Task) => {
    const bugCount = subtask.unresolvedBugCount ?? (subtask.bugs || []).filter((bug) => ['open', 'fixing', 'fixed', 'reopened'].includes(bug.status)).length;
    if (bugCount > 0 || subtask.liveWork?.blocked) return 0;
    if (subtask.status === 'in-progress') return 1;
    if (subtask.status === 'ready-for-review') return 2;
    return 3;
  };
  const visibleSubtasks = [...unfinishedSubtasks].sort((left, right) => subtaskRank(left) - subtaskRank(right)).slice(0, 3);
  const hiddenSubtaskCount = Math.max(0, unfinishedSubtasks.length - visibleSubtasks.length);
  const subtaskProgress = subtasks.length > 0 ? Math.round((completedSubtasks / subtasks.length) * 100) : 0;

  return (
    <div
      draggable
      onDragStart={(e) => {
        setIsDrag(true);
        onDragStart(e, task.id);
      }}
      onDragEnd={() => setIsDrag(false)}
      onClick={() => onSelect(task)}
      className={`group relative flex h-fit w-full min-w-0 select-none flex-col overflow-hidden rounded-[var(--df-radius-lg)] border bg-[var(--df-color-surface-raised)] p-3 text-[var(--df-color-text)] shadow-[var(--df-shadow-sm)] transition-[border-color,box-shadow,opacity] duration-150 cursor-grab active:cursor-grabbing ${
        isDrag
          ? 'border-dashed border-[var(--df-color-warning)] opacity-60'
          : isDone
            ? 'border-[var(--df-color-border)] opacity-80 hover:border-[var(--df-color-border-strong)]'
            : 'border-[var(--df-color-border)] hover:border-[var(--df-color-border-strong)] hover:shadow-[var(--df-shadow-md)]'
      }`} 
      id={`task-card-${task.id}`}
    >
      {!isDrag && (isInProgress || isDone) && (
        <span
          aria-hidden="true"
          className={`absolute inset-y-3 left-0 w-0.5 rounded-full ${isDone ? 'bg-[var(--df-color-success)]' : 'bg-[var(--df-color-warning)]'}`}
        />
      )}
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={handleCopyId}
              className="inline-flex max-w-[132px] items-center gap-1 rounded-md px-1 py-0.5 text-[10px] font-extrabold text-[var(--df-color-accent)] transition-colors hover:bg-[var(--df-color-surface-subtle)]"
              title={`Copy ${taskIdentity}`}
              aria-label={`Copy task ID ${taskIdentity}`}
            >
              <span className="truncate">#{taskIdentity}</span>
              {idCopied && <Check size={11} className="shrink-0 text-[var(--df-color-success)]" />}
            </button>
            {taskCategoryBadge(task)}
            {task.hasUiDesign && (
              <span aria-label="Task has UI Design" className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--df-color-text-muted)]">
                <ImageIcon size={9} />
                Design
              </span>
            )}
          </div>

          <h4 className="mt-1.5 line-clamp-2 break-words text-[13px] font-bold leading-[1.35] text-[var(--df-color-text-strong)]" title={task.title}>
            {task.title}
          </h4>
        </div>

        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(task.id);
          }}
          type="button"
          className="shrink-0 rounded-md p-1.5 text-[var(--df-color-text-subtle)] opacity-60 transition-[opacity,color,background-color] hover:bg-[var(--df-color-danger-surface)] hover:text-[var(--df-color-danger)] sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 focus-visible:opacity-100"
          title={`Remove ${taskIdentity}`}
          aria-label={`Remove task ${taskIdentity}`}
        >
          <Trash2 size={13} />
        </button>
      </div>

      {liveWork && (
        <div
          className={`mt-2 flex min-w-0 items-start gap-1.5 rounded-[var(--df-radius-sm)] border px-2 py-1.5 ${
            liveWork.blocked
              ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
              : 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
          }`}
          aria-label={liveWork.blocked ? 'Live work blocked' : 'Live work active'}
        >
          {liveWork.blocked
            ? <AlertTriangle size={12} className="mt-0.5 shrink-0 text-[var(--df-color-danger)]" />
            : <CircleCheck size={12} className="mt-0.5 shrink-0 text-[var(--df-color-warning)]" />}
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <span className={`shrink-0 text-[9.5px] font-extrabold ${liveWork.blocked ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-warning)]'}`}>
                {liveWork.blocked ? 'Blocked' : 'Live work'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[9px] font-bold text-[var(--df-color-text-muted)]" title={liveWork.phaseLabel}>
                {liveWork.phaseLabel}
              </span>
            </div>
            <div className="mt-0.5 line-clamp-2 break-words text-[9.5px] leading-[1.35] text-[var(--df-color-text-muted)]" title={liveWork.activity || liveWork.ownerLabel}>
              <span className="font-semibold text-[var(--df-color-text)]">{liveWork.ownerLabel}</span>
              {liveWork.activity ? ` · ${liveWork.activity}` : ''}
            </div>
          </div>
          {liveWorkFreshness && <span className="shrink-0 text-[8.5px] font-semibold text-[var(--df-color-text-subtle)]">{liveWorkFreshness}</span>}
          <span className="sr-only" aria-label={`Live work phase: ${liveWork.phaseLabel} (${liveWork.phaseIndex + 1}/${liveWork.phaseCount})`} />
        </div>
      )}

      {task.images && task.images.length > 0 && (
        <div className="relative mt-2 h-16 overflow-hidden rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface)]">
          <img
            src={task.images[0].url}
            alt="Preview"
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            referrerPolicy="no-referrer"
          />
          {task.images.length > 1 && (
            <div className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-bold text-white shadow-sm backdrop-blur-sm">
              +{task.images.length - 1}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--df-color-border)] pt-2 text-[9.5px] font-bold text-[var(--df-color-text-muted)]">
        <span className={`inline-flex shrink-0 items-center gap-1 ${priorityTone}`} title={`${priorityLabel} priority`} aria-label={`${priorityLabel} priority`}>
          {task.priority === 'high' && <Flame size={12} />}
          {task.priority === 'low' && <Coffee size={12} />}
          <span>{priorityLabel}</span>
        </span>

        {filesCount > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1" title={`${filesCount} files`}>
            <FileCode size={12} />
            <span>{filesCount}</span>
          </span>
        )}

        {totalSteps > 0 && (
          <span className={`inline-flex shrink-0 items-center gap-1 ${completedSteps === totalSteps ? 'text-[var(--df-color-success)]' : ''}`} title={`Checklist ${completedSteps} of ${totalSteps}`}>
            <CheckSquare size={12} />
            <span>{completedSteps}/{totalSteps}</span>
          </span>
        )}

        {unresolvedBugCount > 0 && (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-[var(--df-color-danger)]"
            title={isDone ? `Done with ${unresolvedBugCount} unresolved bug${unresolvedBugCount === 1 ? '' : 's'}` : `${unresolvedBugCount} unresolved bug${unresolvedBugCount === 1 ? '' : 's'}`}
            aria-label={isDone ? `Done with ${unresolvedBugCount} unresolved bugs` : `${unresolvedBugCount} unresolved bugs`}
          >
            <AlertTriangle size={12} />
            <span>Bugs {unresolvedBugCount}</span>
          </span>
        )}

        <CopyTemplateButton task={task} variant="icon" className="!h-7 !w-7 !shrink-0 !rounded-md !border-transparent !bg-transparent !p-1 !text-[var(--df-color-text-muted)] hover:!bg-[var(--df-color-surface-subtle)]" />

        {task.specUrl && (
          <span className="ml-auto inline-flex shrink-0 items-center text-[var(--df-color-info)]" title={`Spec linked: ${task.specUrl}`} aria-label="Spec linked">
            <LinkIcon size={11} />
          </span>
        )}
      </div>

      {subtasks.length > 0 && (
        <div className="mt-2 min-w-0 overflow-hidden rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-2" onClick={(e) => e.stopPropagation()}>
          <div className="flex min-w-0 items-center justify-between gap-2 text-[9px] font-extrabold text-[var(--df-color-text-muted)]">
            <span className="min-w-0 truncate">Subtasks {completedSubtasks}/{subtasks.length}</span>
            <span className="shrink-0 text-[var(--df-color-text-subtle)]">{subtaskProgress}%</span>
          </div>
          <div className="mt-1 h-1 overflow-hidden rounded-full bg-[var(--df-color-border)]" aria-label={`Subtask progress ${subtaskProgress}%`}>
            <div className="h-full rounded-full bg-[var(--df-color-accent)]" style={{ width: `${subtaskProgress}%` }} />
          </div>

          {visibleSubtasks.length > 0 && (
            <div className="mt-1.5 flex min-w-0 flex-col gap-1">
              {visibleSubtasks.map((sub) => {
                const subIdentity = sub.displayId || sub.id;
                const subBugCount = sub.unresolvedBugCount ?? (sub.bugs || []).filter((bug) => ['open', 'fixing', 'fixed', 'reopened'].includes(bug.status)).length;
                const subBlocked = subBugCount > 0 || Boolean(sub.liveWork?.blocked);
                const subStatusLabel = subBlocked ? 'blocked' : sub.status === 'in-progress' ? 'active' : sub.status;
                return (
                  <div
                    key={sub.id}
                    draggable
                    onDragStart={(e) => {
                      e.stopPropagation();
                      onDragStart(e, sub.id);
                    }}
                    onClick={() => onSelect(sub)}
                    className="flex min-w-0 items-center gap-1.5 rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-1.5 py-1 text-[9.5px] text-[var(--df-color-text)] transition-colors hover:border-[var(--df-color-border-strong)] cursor-grab active:cursor-grabbing"
                  >
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onUpdate) onUpdate({ ...sub, status: 'done', updatedAt: new Date().toISOString() });
                      }}
                      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border border-[var(--df-color-border-strong)] bg-[var(--df-color-surface-raised)] text-[8px] text-[var(--df-color-text-muted)] hover:border-[var(--df-color-accent)]"
                      aria-label={`Complete subtask ${subIdentity}`}
                      title={`Complete ${subIdentity}`}
                    />
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${subBlocked ? 'bg-[var(--df-color-danger)]' : sub.status === 'in-progress' ? 'bg-[var(--df-color-warning)]' : 'bg-[var(--df-color-text-subtle)]'}`} aria-hidden="true" />
                    <span className="max-w-[78px] shrink-0 truncate font-extrabold text-[var(--df-color-accent)]" title={subIdentity}>{subIdentity}</span>
                    <span className="min-w-0 flex-1 truncate" title={sub.title}>{sub.title}</span>
                    <span className={`max-w-[72px] shrink-0 truncate text-[8px] font-bold uppercase ${subBlocked ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-text-subtle)]'}`} title={subStatusLabel}>{subStatusLabel}</span>
                  </div>
                );
              })}
              {hiddenSubtaskCount > 0 && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelect(task);
                  }}
                  className="self-start rounded px-1 py-0.5 text-[9px] font-bold text-[var(--df-color-accent)] hover:bg-[var(--df-color-surface-raised)]"
                  aria-label={`Open ${hiddenSubtaskCount} more subtasks`}
                >
                  +{hiddenSubtaskCount} more
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 flex min-w-0 items-center gap-2 border-t border-[var(--df-color-border)] pt-1.5 text-[8.5px] font-semibold text-[var(--df-color-text-subtle)]">
        <span className="min-w-0 flex-1 truncate" title={task.branch || 'No active branch'}>
          {task.branch ? `Branch · ${task.branch}` : 'No active branch'}
        </span>
        <span className="shrink-0" title="Last updated">
          {isDone ? 'Merged' : formattedDate}
        </span>
      </div>
    </div>
  );
}
