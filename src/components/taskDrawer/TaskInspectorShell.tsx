import React, { useEffect, useRef, useState } from 'react';
import { Edit3, Maximize2, Minimize2, Trash2, X } from 'lucide-react';
import type { Task } from '../../types';

export type TaskInspectorTab = 'overview' | 'work' | 'bugs' | 'activity';

export const TASK_INSPECTOR_MIN_WIDTH_VW = 45;
export const TASK_INSPECTOR_DEFAULT_WIDTH_VW = 65;
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
  { id: 'bugs', label: 'Bugs' },
  { id: 'activity', label: 'Activity' },
];

export function resolveTaskInspectorTabKey(activeTab: TaskInspectorTab, key: string): TaskInspectorTab | null {
  const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
  if (currentIndex < 0) return null;
  if (key === 'Home') return TABS[0].id;
  if (key === 'End') return TABS[TABS.length - 1].id;
  if (key === 'ArrowRight') return TABS[(currentIndex + 1) % TABS.length].id;
  if (key === 'ArrowLeft') return TABS[(currentIndex - 1 + TABS.length) % TABS.length].id;
  return null;
}

interface TaskInspectorShellProps {
  task: Task;
  activeTab: TaskInspectorTab;
  onTabChange: (tab: TaskInspectorTab) => void;
  onClose: () => void;
  onDelete: () => void;
  isEditing: boolean;
  onToggleEdit: () => void;
  onSave?: () => void;
  onDiscard?: () => void;
  children: React.ReactNode;
}

export default function TaskInspectorShell({
  task,
  activeTab,
  onTabChange,
  onClose,
  onDelete,
  isEditing,
  onToggleEdit,
  onSave,
  onDiscard,
  children,
}: TaskInspectorShellProps) {
  const [widthVw, setWidthVw] = useState(TASK_INSPECTOR_DEFAULT_WIDTH_VW);
  const [fullScreen, setFullScreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Partial<Record<TaskInspectorTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-xs max-lg:p-0 lg:p-4" aria-label="Task inspector overlay">
      <button type="button" aria-label="Close task inspector backdrop" className="fixed inset-0 cursor-default" onClick={onClose} />
      <section
        ref={rootRef}
        tabIndex={-1}
        style={panelStyle}
        className={`relative z-10 flex max-h-screen flex-col overflow-hidden border border-[#e5d4bb] bg-[#fcfaf5] shadow-2xl outline-none dark:border-[#584a3b] dark:bg-[#1e1914] max-lg:!h-screen max-lg:!w-screen max-lg:rounded-none ${fullScreen ? 'rounded-none' : 'rounded-2xl'}`}
      >
        <header className="sticky top-0 z-30 flex shrink-0 items-start justify-between gap-4 border-b border-[#e5d4bb] bg-[#f6ecdc]/95 px-5 py-4 backdrop-blur dark:border-[#584a3b] dark:bg-[#292119]/95">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded-lg border border-[#dfccb1] bg-white px-2.5 py-1 font-mono text-[11px] font-black text-[#7a5d45] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#e9d9c8]">{task.displayId || task.id}</span>
              <span className="rounded-lg bg-[#ffe9c8] px-2.5 py-1 text-[11px] font-extrabold uppercase text-[#965d19] dark:bg-[#3a2f26] dark:text-[#e0a070]">{task.status}</span>
              <span className="rounded-lg border border-[#e4d3bd] px-2.5 py-1 text-[11px] font-bold text-[#806b5b] dark:border-[#584a3b] dark:text-[#cdbdaf]">{task.priority}</span>
              {task.category && <span className="rounded-lg border border-[#e4d3bd] px-2.5 py-1 text-[11px] font-bold text-[#806b5b] dark:border-[#584a3b] dark:text-[#cdbdaf]">{task.category}</span>}
            </div>
            <h2 className="mt-2 truncate text-lg font-black leading-tight text-[#3d2d22] dark:text-[#f4eadf]" title={task.title}>{task.title}</h2>
            <p className="mt-1 text-[11px] text-[#8d7767] dark:text-[#b9aa9c]">Updated {new Date(task.updatedAt).toLocaleString()}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button type="button" onClick={onToggleEdit} className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[#dfccb1] bg-white px-3 text-[11px] font-extrabold text-[#735942] hover:bg-[#fff4e1] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#eadfd5]" aria-label={isEditing ? 'Preview task' : 'Edit task'}>
              <Edit3 size={13} /> {isEditing ? 'Preview' : 'Edit'}
            </button>
            <button type="button" onClick={() => setFullScreen((value) => !value)} aria-label={fullScreen ? 'Exit full screen' : 'Enter full screen'} title={fullScreen ? 'Exit full screen' : 'Enter full screen'} className="flex h-9 w-9 items-center justify-center rounded-lg border border-[#dfccb1] bg-white text-[#806b5b] hover:bg-[#fff4e1] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#d8c8ba]">
              {fullScreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button type="button" onClick={onDelete} aria-label="Delete task" title="Delete task" className="flex h-9 w-9 items-center justify-center rounded-lg text-[#9a7c68] hover:bg-red-50 hover:text-red-600 dark:hover:bg-[#3a2420]">
              <Trash2 size={14} />
            </button>
            <button type="button" onClick={onClose} aria-label="Close task inspector" title="Close task inspector" className="flex h-9 w-9 items-center justify-center rounded-lg text-[#9a7c68] hover:bg-white dark:hover:bg-[#332820]">
              <X size={16} />
            </button>
          </div>
        </header>

        <nav role="tablist" aria-label="Task inspector sections" className="sticky top-0 z-20 flex shrink-0 gap-1 border-b border-[#e5d4bb] bg-[#fcfaf5]/96 px-5 py-2 backdrop-blur dark:border-[#584a3b] dark:bg-[#1e1914]/96">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              ref={(node) => { tabRefs.current[tab.id] = node; }}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              onClick={() => onTabChange(tab.id)}
              onKeyDown={(event) => {
                const nextTab = resolveTaskInspectorTabKey(tab.id, event.key);
                if (!nextTab) return;
                event.preventDefault();
                onTabChange(nextTab);
                tabRefs.current[nextTab]?.focus();
              }}
              className={`min-h-9 rounded-lg px-4 text-[12px] font-extrabold transition-colors ${activeTab === tab.id ? 'bg-[#ffe8c2] text-[#915816] dark:bg-[#3a2f26] dark:text-[#e0a070]' : 'text-[#7c6757] hover:bg-[#f5ebdc] dark:text-[#baaa9c] dark:hover:bg-[#292119]'}`}
            >{tab.label}</button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 text-[13px] leading-6 text-[#514035] dark:text-[#eee4db] lg:px-7 lg:py-6">
          {children}
        </div>

        {isEditing && (
          <footer className="shrink-0 border-t border-[#e5d4bb] bg-[#f6ecdc] px-5 py-3 dark:border-[#584a3b] dark:bg-[#292119]">
            <div className="flex justify-end gap-2">
              <button type="button" onClick={onDiscard} className="min-h-9 rounded-lg border border-[#dfccb1] bg-white px-4 text-[11px] font-extrabold text-[#735942] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#eadfd5]">Discard</button>
              <button type="button" onClick={onSave} className="min-h-9 rounded-lg bg-[#d89745] px-4 text-[11px] font-extrabold text-white hover:bg-[#bf7c2c]">Save changes</button>
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
            className="absolute left-0 top-0 z-40 hidden h-full w-2 cursor-col-resize bg-transparent outline-none after:absolute after:left-0 after:top-0 after:h-full after:w-0.5 after:bg-transparent hover:after:bg-[#d89745] focus-visible:after:bg-[#d89745] lg:block"
          />
        )}
      </section>
    </div>
  );
}
