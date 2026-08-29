import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Edit3, Maximize2, Minimize2, Trash2, X } from 'lucide-react';
import type { Task } from '../../types';

export type TaskInspectorTab = 'overview' | 'work' | 'subtasks' | 'bugs' | 'activity';

export const TASK_INSPECTOR_MIN_WIDTH_VW = 45;
export const TASK_INSPECTOR_DEFAULT_WIDTH_VW = 68;
export const TASK_INSPECTOR_MAX_WIDTH_VW = 85;

export function clampTaskInspectorWidth(widthVw: number) {
  const finite = Number.isFinite(widthVw) ? widthVw : TASK_INSPECTOR_DEFAULT_WIDTH_VW;
  return Math.min(TASK_INSPECTOR_MAX_WIDTH_VW, Math.max(TASK_INSPECTOR_MIN_WIDTH_VW, Math.round(finite * 10) / 10));
}

export function resolveTaskInspectorResize(startWidthVw: number, deltaPx: number, viewportWidth: number) {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return clampTaskInspectorWidth(startWidthVw);
  return clampTaskInspectorWidth(startWidthVw + (deltaPx / viewportWidth) * 100);
}

const TABS: Array<{ id: TaskInspectorTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'work', label: 'Work' },
  { id: 'subtasks', label: 'Subtasks' },
  { id: 'bugs', label: 'Bugs' },
  { id: 'activity', label: 'Activity' },
];

export function resolveTaskInspectorTabKey(activeTab: TaskInspectorTab, key: string, showSubtasks = true): TaskInspectorTab | null {
  const visibleTabs = showSubtasks ? TABS : TABS.filter((tab) => tab.id !== 'subtasks');
  const currentIndex = visibleTabs.findIndex((tab) => tab.id === activeTab);
  if (currentIndex < 0) return null;
  if (key === 'Home') return visibleTabs[0].id;
  if (key === 'End') return visibleTabs[visibleTabs.length - 1].id;
  if (key === 'ArrowRight') return visibleTabs[(currentIndex + 1) % visibleTabs.length].id;
  if (key === 'ArrowLeft') return visibleTabs[(currentIndex - 1 + visibleTabs.length) % visibleTabs.length].id;
  return null;
}

export interface TaskInspectorStatusSummary {
  label: string;
  summary: string;
  nextAction: string;
  tone: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
}

export function resolveTaskInspectorStatusSummary(task: Task): TaskInspectorStatusSummary {
  const latestRunStatus = task.latestAgentRun?.status || '';
  const unresolvedBugs = task.unresolvedBugCount ?? (task.bugs || []).filter((bug) => ['open', 'fixing', 'fixed', 'reopened'].includes(bug.status)).length;

  if (task.liveWork?.blocked) {
    return {
      label: 'Blocked',
      summary: task.liveWork.activity || `${task.liveWork.ownerLabel || 'Current worker'} is blocked during ${task.liveWork.phaseLabel || 'the active phase'}.`,
      nextAction: 'Resolve the blocker first, then resume the existing execution instead of starting duplicate work.',
      tone: 'danger',
    };
  }

  if (!task.activeAgent && ['failed', 'cancelled', 'timed_out', 'timed-out'].includes(latestRunStatus)) {
    return {
      label: 'Run needs attention',
      summary: `The latest agent run ended as ${latestRunStatus.replace('_', ' ')}.`,
      nextAction: 'Open Activity for the failure details and retry only after the cause is understood.',
      tone: 'danger',
    };
  }

  if (task.status === 'ready-for-review') {
    return {
      label: 'Ready for review',
      summary: unresolvedBugs > 0 ? `Implementation is review-ready, with ${unresolvedBugs} unresolved bug thread${unresolvedBugs === 1 ? '' : 's'} still visible.` : 'Implementation is ready for review.',
      nextAction: 'Review the Work evidence and Bugs before moving the task to Done.',
      tone: unresolvedBugs > 0 ? 'warning' : 'info',
    };
  }

  if (task.status === 'done') {
    return {
      label: unresolvedBugs > 0 ? 'Done with follow-up' : 'Done',
      summary: unresolvedBugs > 0 ? `The task is complete, but ${unresolvedBugs} unresolved bug thread${unresolvedBugs === 1 ? '' : 's'} remain recorded.` : 'The task is complete.',
      nextAction: unresolvedBugs > 0 ? 'Use Bugs for follow-up context; Activity and Work retain the completion evidence.' : 'Use Activity and Work only when you need history or technical evidence.',
      tone: unresolvedBugs > 0 ? 'warning' : 'success',
    };
  }

  if (unresolvedBugs > 0) {
    return {
      label: 'Bugs need attention',
      summary: `${unresolvedBugs} unresolved bug thread${unresolvedBugs === 1 ? '' : 's'} still need follow-up.`,
      nextAction: 'Open Bugs for the active defect context before treating this task as clear.',
      tone: 'warning',
    };
  }

  if (task.liveWork || task.activeAgent || task.status === 'in-progress') {
    return {
      label: task.liveWork?.phaseLabel || 'Work in progress',
      summary: task.liveWork?.activity || (task.activeAgent ? `${task.activeAgent} currently owns active work on this task.` : 'This task is currently being implemented.'),
      nextAction: 'Track the current execution in Activity and avoid launching overlapping work.',
      tone: 'warning',
    };
  }

  if (task.status === 'todo') {
    return {
      label: 'Ready to start',
      summary: 'The task is queued for execution but no active work is currently shown.',
      nextAction: 'Start or claim the task when its prerequisites and scope are clear.',
      tone: 'info',
    };
  }

  return {
    label: 'Backlog',
    summary: 'The task is defined but not scheduled for normal execution.',
    nextAction: 'Move it to Todo or start it explicitly when you want it to become runnable.',
    tone: 'neutral',
  };
}

interface TaskInspectorParentControlProps {
  parentTask: Task;
  onSelectParent: (task: Task) => void;
}

export function TaskInspectorParentControl({ parentTask, onSelectParent }: TaskInspectorParentControlProps) {
  const parentId = parentTask.displayId || parentTask.id;
  return (
    <button
      type="button"
      aria-label={`Open parent task ${parentId}`}
      title={`Back to ${parentId} · ${parentTask.title}`}
      onClick={() => onSelectParent(parentTask)}
      className="df-button df-button--secondary mb-2 min-h-8 max-w-full justify-start px-2.5 py-1.5 text-left"
    >
      <ArrowLeft size={13} className="shrink-0" />
      <span className="shrink-0">Back to {parentId}</span>
      <span aria-hidden="true" className="shrink-0 text-[var(--df-color-text-subtle)]">·</span>
      <span className="df-truncate font-bold">{parentTask.title}</span>
    </button>
  );
}

interface TaskInspectorShellProps {
  task: Task;
  activeTab: TaskInspectorTab;
  onTabChange: (tab: TaskInspectorTab) => void;
  onClose: () => void;
  onDelete: () => void;
  isEditing: boolean;
  onToggleEdit: () => void;
  parentTask?: Task;
  onSelectParent?: (task: Task) => void;
  onSave?: () => void;
  onDiscard?: () => void;
  isSaving?: boolean;
  editError?: string | null;
  children: React.ReactNode;
  showSubtasks?: boolean;
}

function statusToneClass(tone: TaskInspectorStatusSummary['tone']) {
  if (tone === 'danger') return 'df-feedback--danger';
  if (tone === 'warning') return 'df-feedback--warning';
  if (tone === 'info') return 'df-feedback--info';
  if (tone === 'success') return 'df-feedback--success';
  return '';
}

export default function TaskInspectorShell({
  task,
  activeTab,
  onTabChange,
  onClose,
  onDelete,
  isEditing,
  onToggleEdit,
  parentTask,
  onSelectParent,
  onSave,
  onDiscard,
  isSaving = false,
  editError = null,
  children,
  showSubtasks = true,
}: TaskInspectorShellProps) {
  const [widthVw, setWidthVw] = useState(TASK_INSPECTOR_DEFAULT_WIDTH_VW);
  const [fullScreen, setFullScreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TaskInspectorTab, HTMLButtonElement | null>>>({});
  const visibleTabs = showSubtasks ? TABS : TABS.filter((tab) => tab.id !== 'subtasks');
  const statusSummary = resolveTaskInspectorStatusSummary(task);
  const latestRunStatus = task.latestAgentRun?.status || '';
  const unresolvedBugs = task.unresolvedBugCount ?? (task.bugs || []).filter((bug) => ['open', 'fixing', 'fixed', 'reopened'].includes(bug.status)).length;
  const hasActionableAttention = Boolean(
    task.liveWork?.blocked
    || (!task.activeAgent && ['failed', 'cancelled', 'timed_out', 'timed-out'].includes(latestRunStatus))
    || task.status === 'ready-for-review'
    || unresolvedBugs > 0,
  );

  const requestClose = useCallback(() => {
    if (isEditing && typeof window !== 'undefined' && !window.confirm('Discard unsaved task edits and close the inspector?')) return;
    if (isEditing) onDiscard?.();
    onClose();
  }, [isEditing, onClose, onDiscard]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [requestClose]);

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (fullScreen) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = widthVw;
    const handleMove = (moveEvent: PointerEvent) => {
      setWidthVw(resolveTaskInspectorResize(startWidth, startX - moveEvent.clientX, window.innerWidth));
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const panelStyle: React.CSSProperties = fullScreen
    ? { width: '100vw', height: '100vh' }
    : { width: `${widthVw}vw`, height: '92vh' };

  return (
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center max-lg:p-0 lg:p-4" aria-label="Task inspector overlay">
      <button type="button" aria-label="Close task inspector backdrop" className="fixed inset-0 cursor-default" onClick={requestClose} />
      <section
        ref={rootRef}
        tabIndex={-1}
        style={panelStyle}
        className={`df-dialog relative z-10 flex max-h-screen flex-col overflow-hidden outline-none max-lg:!h-screen max-lg:!w-screen max-lg:rounded-none ${fullScreen ? 'rounded-none' : ''}`}
      >
        <header className="df-dialog-header sticky top-0 z-30 flex shrink-0 items-start justify-between gap-3 px-4 py-3 backdrop-blur lg:px-5">
          <div className="min-w-0 flex-1">
            {parentTask && onSelectParent && (
              <TaskInspectorParentControl parentTask={parentTask} onSelectParent={onSelectParent} />
            )}
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="rounded-md border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-1.5 py-0.5 font-mono text-[10px] font-black text-[var(--df-color-text-muted)]">{task.displayId || task.id}</span>
              <span className="rounded-md bg-[var(--df-color-warning-surface)] px-1.5 py-0.5 text-[10px] font-extrabold uppercase text-[var(--df-color-warning)]">{task.status}</span>
              <span className="rounded-md border border-[var(--df-color-border)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--df-color-text-muted)]">{task.priority}</span>
              {task.category && <span className="rounded-md border border-[var(--df-color-border)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--df-color-text-muted)]">{task.category}</span>}
              {isEditing && <span className="rounded-md bg-[var(--df-color-info-surface)] px-1.5 py-0.5 text-[10px] font-extrabold text-[var(--df-color-info)]">Editing</span>}
            </div>
            <h2 className="mt-1.5 line-clamp-3 max-w-4xl break-words text-[17px] font-black leading-[1.25] text-[var(--df-color-text-strong)]" title={task.title}>{task.title}</h2>
            <p className="df-meta mt-0.5 text-[9px]">Updated {new Date(task.updatedAt).toLocaleString()}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {!isEditing && (
              <button type="button" onClick={onToggleEdit} className="df-button df-button--primary min-h-8 min-w-0 px-2.5 text-[10px]" aria-label="Edit task">
                <Edit3 size={13} /> Edit
              </button>
            )}
            <button type="button" onClick={() => setFullScreen((value) => !value)} aria-label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={fullScreen ? 'Exit full screen' : 'Enter full screen'} className="df-icon-button border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)]">
              {fullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button type="button" onClick={onDelete} aria-label="Delete task" title="Delete task" className="df-icon-button opacity-65 hover:!text-[var(--df-color-danger)] hover:opacity-100">
              <Trash2 size={14} />
            </button>
            <button type="button" onClick={requestClose} aria-label="Close task inspector" title="Close task inspector" className="df-icon-button">
              <X size={16} />
            </button>
          </div>
        </header>

        {!isEditing && hasActionableAttention && (
          <div className="shrink-0 border-b border-[var(--df-color-border)] bg-[var(--df-color-surface)] px-4 py-2 lg:px-5">
            <div data-testid="task-inspector-attention" className={`df-feedback ${statusToneClass(statusSummary.tone)} flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 px-2.5 py-2`}>
              <span className="df-feedback__summary shrink-0">{statusSummary.label}</span>
              <span className="df-feedback__detail min-w-0 flex-1 break-words">{statusSummary.summary}</span>
              <span className="min-w-0 break-words text-[10px] font-semibold opacity-85">{statusSummary.nextAction}</span>
            </div>
          </div>
        )}

        <nav role="tablist" aria-label="Task inspector sections" data-density="compact" className="sticky top-0 z-20 flex shrink-0 gap-0 overflow-x-auto border-b border-[var(--df-color-border)] bg-[var(--df-color-surface)] px-4 backdrop-blur lg:px-5">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              ref={(node) => { tabRefs.current[tab.id] = node; }}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => {
                const nextTab = resolveTaskInspectorTabKey(tab.id, event.key, showSubtasks);
                if (!nextTab) return;
                event.preventDefault();
                onTabChange(nextTab);
                tabRefs.current[nextTab]?.focus();
              }}
              className={`min-h-8 flex-none border-b-2 px-3 text-[11px] font-extrabold transition-colors ${activeTab === tab.id ? 'border-[var(--df-color-accent)] text-[var(--df-color-text-strong)]' : 'border-transparent text-[var(--df-color-text-muted)] hover:bg-[var(--df-color-surface-subtle)] hover:text-[var(--df-color-text)]'}`}
            >{tab.label}</button>
          ))}
        </nav>

        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-4 py-4 text-[13px] leading-6 text-[var(--df-color-text)] lg:px-5 lg:py-4">
          {children}
        </div>

        {isEditing && (
          <footer className="df-dialog-footer shrink-0 px-5 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                {editError ? (
                  <div role="alert" className="df-feedback df-feedback--danger py-2">
                    <div className="df-feedback__summary">Could not save changes</div>
                    <div className="df-feedback__detail break-words">{editError}</div>
                  </div>
                ) : (
                  <p className="df-meta">Editing task · changes are local until you save them.</p>
                )}
              </div>
              <div className="flex shrink-0 justify-end gap-2">
                <button type="button" onClick={onDiscard} disabled={isSaving} className="df-button df-button--secondary">Cancel</button>
                <button type="button" onClick={onSave} disabled={isSaving} className="df-button df-button--primary">{isSaving ? 'Saving…' : 'Save changes'}</button>
              </div>
            </div>
          </footer>
        )}

        {!fullScreen && (
          <button
            type="button"
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize task inspector"
            title="Drag to resize task inspector"
            onPointerDown={startResize}
            onKeyDown={(event) => {
              if (event.key === 'ArrowLeft') setWidthVw((value) => clampTaskInspectorWidth(value + 2));
              if (event.key === 'ArrowRight') setWidthVw((value) => clampTaskInspectorWidth(value - 2));
            }}
            className="absolute left-0 top-0 z-40 hidden h-full w-2 cursor-col-resize bg-transparent outline-none after:absolute after:left-0 after:top-0 after:h-full after:w-0.5 after:bg-transparent hover:after:bg-[var(--df-color-accent)] focus-visible:after:bg-[var(--df-color-accent)] lg:block"
          />
        )}
      </section>
    </div>
  );
}
