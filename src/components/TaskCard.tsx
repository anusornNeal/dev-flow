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
import { getDisplayModelName } from '../lib/agentsConfig';
import { getAutoWorkState } from '../lib/autoWorkState';
import CopyTemplateButton from './CopyTemplateButton';
import { AgentLogo } from './AgentLogo';

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

export default function TaskCard({ task, subtasks = [], onSelect, onDelete, onDragStart, onUpdate, onShowLog }: TaskCardProps) {
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
  const hasEffectiveAssignment = Boolean(task.agent || task.model || task.effort);
  const autoWorkState = getAutoWorkState(task);
  const liveWork = task.liveWork;
  const liveWorkAgeMs = liveWork?.updatedAt ? Math.max(0, Date.now() - Date.parse(liveWork.updatedAt)) : null;
  const liveWorkFreshness = liveWorkAgeMs == null || !Number.isFinite(liveWorkAgeMs)
    ? null
    : liveWorkAgeMs < 60_000
      ? 'now'
      : liveWorkAgeMs < 60 * 60_000
        ? `${Math.floor(liveWorkAgeMs / 60_000)}m`
        : `${Math.floor(liveWorkAgeMs / (60 * 60_000))}h`;

  const runStatusTone = autoWorkState
    ? autoWorkState.kind === 'failed' || autoWorkState.kind === 'timed-out'
      ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] text-[var(--df-color-danger)]'
      : autoWorkState.kind === 'ready-for-review'
        ? 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)] text-[var(--df-color-success)]'
        : ['queued-busy', 'queued', 'launching', 'running'].includes(autoWorkState.kind)
          ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] text-[var(--df-color-warning)]'
          : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] text-[var(--df-color-text-muted)]'
    : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] text-[var(--df-color-text-muted)]';

  const priorityLabel = task.priority === 'high' ? 'High' : task.priority === 'low' ? 'Low' : 'Medium';
  const priorityTone = task.priority === 'high'
    ? 'text-[var(--df-color-danger)]'
    : task.priority === 'low'
      ? 'text-[var(--df-color-text-subtle)]'
      : 'text-[var(--df-color-text-muted)]';
  const taskIdentity = task.displayId || task.id;

  return (
    <div
      draggable
      onDragStart={(e) => {
        setIsDrag(true);
        onDragStart(e, task.id);
      }}
      onDragEnd={() => setIsDrag(false)}
      onClick={() => onSelect(task)}
      className={`group relative flex h-fit w-full min-w-0 select-none flex-col overflow-hidden rounded-[var(--df-radius-lg)] border bg-[var(--df-color-surface-raised)] p-4 text-[var(--df-color-text)] shadow-[var(--df-shadow-sm)] transition-[border-color,box-shadow,opacity] duration-150 cursor-grab active:cursor-grabbing ${
        isDrag
          ? 'border-dashed border-[var(--df-color-warning)] opacity-60'
          : isInProgress
            ? 'border-[var(--df-color-warning)] shadow-[var(--df-shadow-md)]'
            : isDone
              ? 'border-[var(--df-color-success)] border-l-4'
              : 'border-[var(--df-color-border)] hover:border-[var(--df-color-border-strong)] hover:shadow-[var(--df-shadow-md)]'
      }`}
      id={`task-card-${task.id}`}
    >
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

          <h4 className="mt-2 line-clamp-3 break-words text-[14px] font-extrabold leading-[1.4] text-[var(--df-color-text-strong)]" title={task.title}>
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
          className={`mt-3 min-w-0 rounded-[var(--df-radius-md)] border px-2.5 py-2 ${
            liveWork.blocked
              ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
              : 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)]'
          }`}
          aria-label={liveWork.blocked ? 'Live work blocked' : 'Live work active'}
        >
          <div className="flex min-w-0 items-center gap-1.5">
            {liveWork.blocked
              ? <AlertTriangle size={12} className="shrink-0 text-[var(--df-color-danger)]" />
              : <CircleCheck size={12} className="shrink-0 text-[var(--df-color-warning)]" />}
            <span className={`shrink-0 text-[10px] font-extrabold ${liveWork.blocked ? 'text-[var(--df-color-danger)]' : 'text-[var(--df-color-warning)]'}`}>
              {liveWork.blocked ? 'Blocked' : 'Live work'}
            </span>
            <span className="min-w-0 flex-1 truncate text-right text-[9px] font-bold text-[var(--df-color-text-muted)]" title={liveWork.phaseLabel}>
              {liveWork.phaseLabel}
            </span>
          </div>

          <div className="mt-1.5 flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[11px] font-bold text-[var(--df-color-text)]" title={liveWork.ownerLabel}>
              {liveWork.ownerLabel}
            </span>
            {liveWorkFreshness && <span className="shrink-0 text-[9px] font-semibold text-[var(--df-color-text-subtle)]">{liveWorkFreshness}</span>}
          </div>

          {liveWork.activity && (
            <div className="mt-1 line-clamp-2 break-words text-[9.5px] leading-relaxed text-[var(--df-color-text-muted)]" title={liveWork.activity}>
              {liveWork.activity}
            </div>
          )}

          <div className="mt-2 flex gap-1" aria-label={`Live work phase: ${liveWork.phaseLabel}`}>
            {Array.from({ length: liveWork.phaseCount }).map((_, index) => (
              <span
                key={index}
                className={`h-1 min-w-0 flex-1 rounded-full ${
                  index <= liveWork.phaseIndex
                    ? liveWork.blocked && index === liveWork.phaseIndex
                      ? 'bg-[var(--df-color-danger)]'
                      : 'bg-[var(--df-color-warning)]'
                    : 'bg-[var(--df-color-border)]'
                }`}
              />
            ))}
          </div>
        </div>
      )}

      {!liveWork && (task.activeAgent || autoWorkState) && (
        <div className="mt-3 min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-2.5 py-2" aria-label={`Execution state: ${autoWorkState?.label || 'Assigned'}`}>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {task.activeAgent && (
              <span className="inline-flex min-w-0 max-w-[150px] items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--df-color-text-muted)]" title={`Assigned to ${task.activeAgent}`}>
                <AgentLogo agent={task.activeAgent} size={9} className="shrink-0" />
                <span className="truncate">{task.activeAgent}</span>
              </span>
            )}

            {hasEffectiveAssignment && autoWorkState && (
              <span className={`inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[9px] font-extrabold ${runStatusTone}`}>
                {autoWorkState.label}
              </span>
            )}

            {task.agentRuns && task.agentRuns.some(r => r.logFile) && (
              <button
                type="button"
                className="ml-auto shrink-0 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-1.5 py-0.5 text-[9px] font-bold text-[var(--df-color-text-muted)] transition-colors hover:border-[var(--df-color-info)] hover:text-[var(--df-color-info)]"
                title="View latest run log"
                onClick={(e) => {
                  e.stopPropagation();
                  if (!onShowLog) return;
                  const latest = task.agentRuns!.filter(r => r.logFile).slice(-1)[0];
                  if (latest) onShowLog({ id: latest.id, status: latest.status, agent: task.agent, model: task.model });
                }}
              >
                Log
              </button>
            )}
          </div>

          {autoWorkState?.message && (
            <div className={`mt-1.5 line-clamp-2 break-words text-[9.5px] leading-relaxed ${
              autoWorkState.kind === 'failed' || autoWorkState.kind === 'timed-out'
                ? 'text-[var(--df-color-danger)]'
                : 'text-[var(--df-color-text-muted)]'
            }`} title={autoWorkState.message}>
              {autoWorkState.message}
            </div>
          )}
        </div>
      )}

      {task.images && task.images.length > 0 && (
        <div className="relative mt-3 h-20 overflow-hidden rounded-[var(--df-radius-sm)] border border-[var(--df-color-border)] bg-[var(--df-color-surface)]">
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

      <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-t border-[var(--df-color-border)] pt-2.5 text-[10px] font-bold text-[var(--df-color-text-muted)]">
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
        <div className="mt-2.5 min-w-0 overflow-hidden rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-2" onClick={(e) => e.stopPropagation()}>
          <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2 text-[9px] font-extrabold text-[var(--df-color-text-muted)]">
            <span className="min-w-0 truncate">Subtasks {subtasks.filter(s => s.status === 'done').length}/{subtasks.length}</span>
            <span className="shrink-0 text-[var(--df-color-text-subtle)]">{Math.round((subtasks.filter(s => s.status === 'done').length / subtasks.length) * 100)}%</span>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            {subtasks.map(sub => {
              const subDone = sub.status === 'done';
              const subInProgress = sub.status === 'in-progress';
              const subIdentity = sub.displayId || sub.id;
              const subStatusLabel = subInProgress ? 'active' : sub.status;
              return (
                <div
                  key={sub.id}
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    onDragStart(e, sub.id);
                  }}
                  onClick={() => onSelect(sub)}
                  className={`min-w-0 rounded-[var(--df-radius-sm)] border p-1.5 text-[10px] transition-colors cursor-grab active:cursor-grabbing ${
                    subDone
                      ? 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)] text-[var(--df-color-text-muted)]'
                      : subInProgress
                        ? 'border-[var(--df-color-warning)] bg-[var(--df-color-warning-surface)] text-[var(--df-color-text)]'
                        : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] text-[var(--df-color-text)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-1.5">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onUpdate) {
                          onUpdate({
                            ...sub,
                            status: sub.status === 'done' ? 'todo' : 'done',
                            updatedAt: new Date().toISOString(),
                          });
                        }
                      }}
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[9px] transition-colors ${
                        subDone
                          ? 'border-[var(--df-color-success)] bg-[var(--df-color-success)] text-white'
                          : 'border-[var(--df-color-border-strong)] bg-[var(--df-color-surface-raised)] text-[var(--df-color-text-muted)] hover:border-[var(--df-color-accent)]'
                      }`}
                      aria-label={`${subDone ? 'Reopen' : 'Complete'} subtask ${subIdentity}`}
                      title={`${subDone ? 'Reopen' : 'Complete'} ${subIdentity}`}
                    >
                      {subDone ? '✓' : ''}
                    </button>
                    <span className="max-w-[88px] shrink-0 truncate rounded bg-[var(--df-color-surface-muted)] px-1 py-0.5 text-[8.5px] font-extrabold text-[var(--df-color-accent)]" title={subIdentity}>
                      {subIdentity}
                    </span>
                    <span className={`min-w-0 flex-1 truncate text-[10px] ${subDone ? 'line-through' : ''}`} title={sub.title}>
                      {sub.title}
                    </span>
                  </div>

                  <div className="ml-[22px] mt-1 flex min-w-0 items-center gap-1 text-[8px] font-bold text-[var(--df-color-text-muted)]">
                    {sub.model && (
                      <span className="inline-flex min-w-0 max-w-[132px] items-center gap-1 rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] px-1.5 py-0.5" title={getDisplayModelName(undefined, sub.model)}>
                        <AgentLogo agent={sub.model} size={8} className="shrink-0" />
                        <span className="truncate">{getDisplayModelName(undefined, sub.model)}</span>
                      </span>
                    )}
                    <span className="max-w-[100px] shrink-0 truncate rounded-md border border-[var(--df-color-border)] px-1 py-0.5 uppercase" title={sub.status}>
                      {subStatusLabel}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="mt-2.5 flex min-w-0 items-center gap-2 border-t border-[var(--df-color-border)] pt-2 text-[9px] font-semibold text-[var(--df-color-text-subtle)]">
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
