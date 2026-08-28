/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  Filter,
  FolderGit,
  Monitor,
  Search,
  Settings,
} from 'lucide-react';
import { Task, TaskPriority, Project } from '../types';
import { SIDEBAR_RAIL_WIDTH, resolveSidebarResize } from './layout/appShellLayout';

export type SidebarPage = 'board' | 'previews' | 'agent-office';

interface SidebarProps {
  tasks: Task[];
  projects: Project[];
  activeProjectId: string;
  selectedPriority: TaskPriority | 'all';
  setSelectedPriority: (priority: TaskPriority | 'all') => void;
  selectedTag: string | 'all';
  setSelectedTag: (tag: string | 'all') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onOpenSettings: () => void;
  activePage?: SidebarPage;
  onSetActivePage?: (page: SidebarPage) => void;
  isCollapsed?: boolean;
  width?: number;
  onToggleCollapsed?: () => void;
  onWidthChange?: (width: number) => void;
}

export { formatProjectRepoLabel } from './ProjectSwitcher';
import { formatProjectRepoLabel } from './ProjectSwitcher';

const navigationItems: Array<{
  page: SidebarPage;
  label: string;
  description: string;
  icon: React.ComponentType<{ size?: number }>;
}> = [
  { page: 'board', label: 'Sprint Board', description: 'Plan and move work', icon: FolderGit },
  { page: 'agent-office', label: 'Agent Office', description: 'See active workers', icon: Activity },
  { page: 'previews', label: 'UI Previews', description: 'Inspect design evidence', icon: Monitor },
];

export default function Sidebar({
  tasks,
  projects,
  activeProjectId,
  selectedPriority,
  setSelectedPriority,
  selectedTag,
  setSelectedTag,
  searchQuery,
  setSearchQuery,
  onOpenSettings,
  activePage = 'board',
  onSetActivePage,
  isCollapsed = false,
  width = 288,
  onToggleCollapsed,
  onWidthChange,
}: SidebarProps) {
  const mainTasks = tasks.filter((task) => !task.parentId);
  const totalTasks = mainTasks.length;
  const completedTasks = mainTasks.filter((task) => task.status === 'done').length;
  const activeProject = projects.find((project) => project.id === activeProjectId);

  const tagsMap = new Map<string, number>();
  mainTasks.forEach((task) => {
    task.tags.forEach((tag) => tagsMap.set(tag, (tagsMap.get(tag) || 0) + 1));
  });
  const allTags = Array.from(tagsMap.entries()).sort((a, b) => b[1] - a[1]);

  const priorityCounts: Record<TaskPriority, number> = {
    high: mainTasks.filter((task) => task.priority === 'high').length,
    medium: mainTasks.filter((task) => task.priority === 'medium').length,
    low: mainTasks.filter((task) => task.priority === 'low').length,
  };

  const setPage = (page: SidebarPage) => onSetActivePage?.(page);

  if (isCollapsed) {
    return (
      <aside
        className="hidden h-full shrink-0 select-none flex-col border-r border-df-border bg-df-surface px-2 py-3 lg:flex"
        style={{ width: `${SIDEBAR_RAIL_WIDTH}px` }}
        aria-label="Primary navigation"
      >
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-df-primary text-[11px] font-black text-[var(--df-color-primary-text)]" title="DevFlow">
          DF
        </div>

        <nav className="mt-4 flex flex-col gap-2" aria-label="Workspace destinations">
          {navigationItems.map(({ page, label, icon: Icon }) => (
            <button
              key={page}
              type="button"
              onClick={() => setPage(page)}
              title={label}
              aria-label={label}
              aria-current={activePage === page ? 'page' : undefined}
              className={`flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)] ${
                activePage === page
                  ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted text-df-accent'
                  : 'border-transparent text-df-text-muted hover:border-df-border hover:bg-df-surface-muted hover:text-df-text'
              }`}
            >
              <Icon size={18} />
            </button>
          ))}
          <button
            type="button"
            onClick={() => {
              setPage('board');
              onToggleCollapsed?.();
            }}
            title="Search and filters"
            aria-label="Search and filters"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-transparent text-df-text-muted transition-colors hover:border-df-border hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
          >
            <Search size={17} />
          </button>
        </nav>

        <div className="my-4 h-px bg-df-border" />
        <div className="flex min-h-0 flex-1 flex-col items-center gap-2" title={activeProject?.name || 'No active project'}>
          <span className="max-h-52 truncate [writing-mode:vertical-rl] rotate-180 text-[9px] font-black uppercase tracking-[0.12em] text-df-text-muted">
            {activeProject?.taskIdPrefix || activeProject?.name || 'Project'}
          </span>
          <span className="rounded-full border border-df-border bg-df-surface-muted px-1.5 py-1 text-[9px] font-black text-df-accent" title="Task count">
            {totalTasks}
          </span>
        </div>

        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          aria-label="Settings"
          className="mt-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-transparent text-df-text-muted transition-colors hover:border-df-border hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
        >
          <Settings size={17} />
        </button>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Expand sidebar"
          aria-label="Expand sidebar"
          className="mt-2 flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-df-border text-df-text-muted transition-colors hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
        >
          <ChevronRight size={17} />
        </button>
      </aside>
    );
  }

  const handleResizePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const handleMove = (moveEvent: PointerEvent) => {
      onWidthChange?.(resolveSidebarResize(startWidth, moveEvent.clientX - startX));
    };
    const handleUp = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    };
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  };

  const priorityOptions: Array<{ value: TaskPriority | 'all'; label: string; count: number }> = [
    { value: 'all', label: 'All priorities', count: totalTasks },
    { value: 'high', label: 'High', count: priorityCounts.high },
    { value: 'medium', label: 'Medium', count: priorityCounts.medium },
    { value: 'low', label: 'Low', count: priorityCounts.low },
  ];

  return (
    <aside
      className="relative flex h-auto w-full shrink-0 select-none flex-col border-b border-df-border bg-df-surface lg:h-full lg:w-auto lg:border-b-0 lg:border-r"
      style={{ width: `${width}px` }}
      aria-label="Primary navigation"
    >
      <div className="flex items-center gap-3 border-b border-df-border px-4 py-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-df-primary text-[10px] font-black text-[var(--df-color-primary-text)]">
          DF
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[12px] font-black text-df-text">DevFlow</p>
          <p className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-df-text-muted">Workspace control</p>
        </div>
        <button
          type="button"
          onClick={onToggleCollapsed}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-df-border text-df-text-muted transition-colors hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
        >
          <ChevronLeft size={16} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
        <section>
          <p className="px-2 text-[9px] font-black uppercase tracking-[0.16em] text-df-text-muted">Navigate</p>
          <nav className="mt-2 space-y-1" aria-label="Workspace destinations">
            {navigationItems.map(({ page, label, description, icon: Icon }) => {
              const active = activePage === page;
              return (
                <button
                  key={page}
                  type="button"
                  onClick={() => setPage(page)}
                  aria-current={active ? 'page' : undefined}
                  className={`flex w-full cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)] ${
                    active
                      ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted text-df-text'
                      : 'border-transparent text-df-text-muted hover:border-df-border hover:bg-df-surface-muted hover:text-df-text'
                  }`}
                >
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${active ? 'bg-df-surface-raised text-df-accent' : 'bg-df-surface-muted text-df-text-muted'}`}>
                    <Icon size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-extrabold">{label}</span>
                    <span className="mt-0.5 block truncate text-[9px] text-df-text-muted">{description}</span>
                  </span>
                  {page === 'board' && (
                    <span className="shrink-0 rounded-full border border-df-border bg-df-surface-raised px-2 py-0.5 text-[9px] font-bold text-df-text-muted">{totalTasks}</span>
                  )}
                </button>
              );
            })}
          </nav>
        </section>

        <section className="mt-5 border-t border-df-border pt-4">
          <p className="px-2 text-[9px] font-black uppercase tracking-[0.16em] text-df-text-muted">Board project</p>
          <div className="mt-2 min-w-0 rounded-xl border border-df-border bg-df-surface-muted p-3">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded-md bg-df-surface-raised px-2 py-1 text-[9px] font-black text-df-accent">
                {activeProject?.taskIdPrefix || '—'}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-df-text" title={activeProject?.name}>
                {activeProject?.name || 'No active project'}
              </span>
            </div>
            <p className="mt-2 truncate text-[9px] font-mono text-df-text-muted" title={activeProject?.repoUrl || undefined}>
              {activeProject ? formatProjectRepoLabel(activeProject.repoUrl) : 'Select a project from the Board header'}
            </p>
            <p className="mt-2 text-[9px] text-df-text-muted">
              {completedTasks} of {totalTasks} top-level tasks complete
            </p>
          </div>
        </section>

        {activePage === 'board' ? (
          <section className="mt-5 border-t border-df-border pt-4">
            <div className="flex items-center justify-between gap-2 px-2">
              <p className="text-[9px] font-black uppercase tracking-[0.16em] text-df-text-muted">Board filters</p>
              {(searchQuery || selectedPriority !== 'all' || selectedTag !== 'all') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setSelectedPriority('all');
                    setSelectedTag('all');
                  }}
                  className="text-[9px] font-bold text-df-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                >
                  Clear
                </button>
              )}
            </div>

            <label className="mt-2 flex items-center gap-2 rounded-xl border border-df-border bg-df-surface-raised px-3 py-2.5 focus-within:ring-2 focus-within:ring-[var(--df-color-focus-ring)]">
              <Search size={14} className="shrink-0 text-df-text-muted" />
              <input
                type="search"
                className="min-w-0 flex-1 bg-transparent text-[10px] text-df-text outline-none placeholder:text-df-text-muted"
                placeholder="Search tickets…"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                aria-label="Search board tickets"
              />
            </label>

            <div className="mt-3">
              <div className="flex items-center gap-1.5 px-2 text-[9px] font-bold text-df-text-muted">
                <Filter size={11} /> Priority
              </div>
              <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                {priorityOptions.map((option) => {
                  const active = selectedPriority === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setSelectedPriority(option.value)}
                      aria-pressed={active}
                      className={`flex min-w-0 items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-[9px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)] ${
                        active
                          ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted text-df-text'
                          : 'border-df-border bg-df-surface-raised text-df-text-muted hover:bg-df-surface-muted hover:text-df-text'
                      }`}
                    >
                      <span className="truncate">{option.label}</span>
                      <span className="shrink-0 font-mono">{option.count}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {allTags.length > 0 && (
              <div className="mt-3">
                <p className="px-2 text-[9px] font-bold text-df-text-muted">Tags</p>
                <div className="mt-1.5 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto px-0.5 py-0.5">
                  <button
                    type="button"
                    onClick={() => setSelectedTag('all')}
                    aria-pressed={selectedTag === 'all'}
                    className={`max-w-full rounded-full border px-2.5 py-1 text-[9px] font-bold ${selectedTag === 'all' ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted text-df-text' : 'border-df-border bg-df-surface-raised text-df-text-muted'}`}
                  >
                    All tags
                  </button>
                  {allTags.map(([tag, count]) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setSelectedTag(tag)}
                      aria-pressed={selectedTag === tag}
                      title={`${tag} (${count})`}
                      className={`flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-[9px] font-bold ${selectedTag === tag ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted text-df-text' : 'border-df-border bg-df-surface-raised text-df-text-muted'}`}
                    >
                      <span className="max-w-[140px] truncate">{tag}</span>
                      <span className="shrink-0 font-mono opacity-70">{count}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </section>
        ) : (
          <section className="mt-5 border-t border-df-border pt-4">
            <div className="rounded-xl border border-df-border bg-df-surface-muted p-3">
              <p className="text-[10px] font-bold text-df-text">Board filters are scoped to Sprint Board.</p>
              <button
                type="button"
                onClick={() => setPage('board')}
                className="mt-2 text-[9px] font-extrabold text-df-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
              >
                Open Sprint Board
              </button>
            </div>
          </section>
        )}
      </div>

      <div className="border-t border-df-border p-3">
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="flex w-full items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-left text-[10px] font-extrabold text-df-text-muted transition-colors hover:border-df-border hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
        >
          <Settings size={15} />
          <span>Settings</span>
        </button>
      </div>

      <button
        type="button"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize sidebar"
        onPointerDown={handleResizePointerDown}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') onWidthChange?.(resolveSidebarResize(width, -16));
          if (event.key === 'ArrowRight') onWidthChange?.(resolveSidebarResize(width, 16));
        }}
        className="absolute right-[-4px] top-0 hidden h-full w-2 cursor-col-resize bg-transparent outline-none after:absolute after:left-1/2 after:top-0 after:h-full after:w-px after:-translate-x-1/2 after:bg-transparent hover:after:bg-df-accent focus-visible:after:bg-df-accent lg:block"
      />
    </aside>
  );
}
