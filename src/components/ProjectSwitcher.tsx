import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, ChevronDown, FolderGit, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Project } from '../types';
import ConfirmModal from './ConfirmModal';

export const PROJECT_SWITCHER_POPOVER_CLASS = 'fixed z-[80] w-[400px] max-w-[calc(100vw-2rem)]';
export const PROJECT_SWITCHER_ORDER_STORAGE_KEY = 'devflow.project-switcher.order.v1';

interface ProjectOrderStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

interface ProjectSwitcherTriggerRect {
  left: number;
  bottom: number;
}

export interface ProjectSwitcherPopoverLayout {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export function resolveProjectSwitcherPopoverLayout(
  trigger: ProjectSwitcherTriggerRect,
  viewportWidth: number,
  viewportHeight: number,
  preferredWidth = 400,
  margin = 16,
  gap = 8,
): ProjectSwitcherPopoverLayout {
  const safeWidth = Math.max(0, Number.isFinite(viewportWidth) ? viewportWidth : 0);
  const safeHeight = Math.max(0, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const width = Math.max(0, Math.min(preferredWidth, safeWidth - margin * 2));
  const maxLeft = Math.max(margin, safeWidth - margin - width);
  const left = Math.min(Math.max(trigger.left, margin), maxLeft);
  const desiredTop = trigger.bottom + gap;
  const latestUsefulTop = Math.max(margin, safeHeight - margin - 120);
  const top = Math.min(Math.max(desiredTop, margin), latestUsefulTop);
  const maxHeight = Math.max(0, safeHeight - top - margin);
  return { left, top, width, maxHeight };
}

export function readProjectOrder(storage?: ProjectOrderStorage | null): string[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(PROJECT_SWITCHER_ORDER_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function writeProjectOrder(storage: ProjectOrderStorage | null | undefined, order: string[]) {
  if (!storage) return;
  try {
    storage.setItem(PROJECT_SWITCHER_ORDER_STORAGE_KEY, JSON.stringify(order));
  } catch {
    // Presentation preference persistence must never block project switching.
  }
}

export function reconcileProjectOrder(projects: Project[], storedOrder: string[]): string[] {
  const validIds = new Set(projects.map((project) => project.id));
  const seen = new Set<string>();
  const reconciled: string[] = [];
  for (const id of storedOrder) {
    if (!validIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    reconciled.push(id);
  }
  for (const project of projects) {
    if (seen.has(project.id)) continue;
    seen.add(project.id);
    reconciled.push(project.id);
  }
  return reconciled;
}

export function orderProjects(projects: Project[], order: string[]): Project[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  return reconcileProjectOrder(projects, order)
    .map((id) => byId.get(id))
    .filter((project): project is Project => Boolean(project));
}

export function moveProjectOrder(order: string[], projectId: string, direction: -1 | 1): string[] {
  const currentIndex = order.indexOf(projectId);
  if (currentIndex < 0) return [...order];
  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= order.length) return [...order];
  const next = [...order];
  [next[currentIndex], next[nextIndex]] = [next[nextIndex], next[currentIndex]];
  return next;
}

export function formatProjectRepoLabel(repoUrl?: string | null) {
  return repoUrl?.replace(/^https?:\/\/(www\.)?/, '') || 'No repository URL';
}

export function filterProjectOptions(projects: Project[], query: string) {
  const normalized = query.trim().toLowerCase();
  return projects.filter((project) => {
    if (!normalized) return true;
    const haystack = [project.name, project.repoUrl, project.localPath, project.taskIdPrefix]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return normalized.split(/\s+/).every((token) => haystack.includes(token));
  });
}

export type ProjectSwitcherKeyAction =
  | { type: 'highlight'; index: number }
  | { type: 'select'; index: number }
  | { type: 'close' }
  | { type: 'none' };

export function resolveProjectSwitcherKeyAction(
  key: string,
  highlightedIndex: number,
  itemCount: number,
): ProjectSwitcherKeyAction {
  if (key === 'Escape') return { type: 'close' };
  if (itemCount <= 0) return { type: 'none' };
  const current = Math.min(Math.max(highlightedIndex, 0), itemCount - 1);
  if (key === 'ArrowDown') return { type: 'highlight', index: (current + 1) % itemCount };
  if (key === 'ArrowUp') return { type: 'highlight', index: (current - 1 + itemCount) % itemCount };
  if (key === 'Enter') return { type: 'select', index: current };
  return { type: 'none' };
}

interface ProjectSwitcherProps {
  projects: Project[];
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  onCreateProject: (name: string, repoUrl: string, description?: string, localPath?: string, taskIdPrefix?: string) => Promise<boolean>;
  onDeleteProject: (id: string) => Promise<boolean>;
  onUpdateProject: (id: string, updates: Partial<Project>) => Promise<boolean>;
}

const emptyCreateForm = {
  name: '',
  repoUrl: '',
  description: '',
  localPath: '',
  taskIdPrefix: '',
};

export default function ProjectSwitcher({
  projects,
  activeProjectId,
  setActiveProjectId,
  onCreateProject,
  onDeleteProject,
  onUpdateProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const [isCreating, setIsCreating] = useState(false);
  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [editLocalPath, setEditLocalPath] = useState('');
  const [editTaskIdPrefix, setEditTaskIdPrefix] = useState('');
  const [projectToDelete, setProjectToDelete] = useState<string | null>(null);
  const [projectOrder, setProjectOrder] = useState<string[]>(() => typeof window === 'undefined' ? [] : readProjectOrder(window.localStorage));
  const [popoverLayout, setPopoverLayout] = useState<ProjectSwitcherPopoverLayout | null>(null);
  const projectsLoadedRef = useRef(projects.length > 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0];
  const orderedProjects = useMemo(() => orderProjects(projects, projectOrder), [projects, projectOrder]);
  const filteredProjects = useMemo(() => filterProjectOptions(orderedProjects, query), [orderedProjects, query]);

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    setIsCreating(false);
    setEditingProjectId(null);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const updatePopoverLayout = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return;
    const rect = triggerRef.current.getBoundingClientRect();
    setPopoverLayout(resolveProjectSwitcherPopoverLayout(rect, window.innerWidth, window.innerHeight));
  }, []);

  useEffect(() => {
    if (projects.length > 0) projectsLoadedRef.current = true;
    if (!projectsLoadedRef.current) return;
    setProjectOrder((current) => {
      const next = reconcileProjectOrder(projects, current);
      return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
    });
  }, [projects]);

  useEffect(() => {
    if (typeof window !== 'undefined') writeProjectOrder(window.localStorage, projectOrder);
  }, [projectOrder]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;

    const handleOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(true);
    };
    const handleViewportChange = () => updatePopoverLayout();

    updatePopoverLayout();
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', handleViewportChange);
    window.addEventListener('scroll', handleViewportChange, true);
    requestAnimationFrame(() => searchRef.current?.focus());

    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', handleViewportChange);
      window.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [close, open, updatePopoverLayout]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query, activeProjectId]);

  const selectProject = (project: Project) => {
    setActiveProjectId(project.id);
    close(false);
  };

  const moveProject = (projectId: string, direction: -1 | 1) => {
    const currentOrder = reconcileProjectOrder(projects, projectOrder);
    const nextOrder = moveProjectOrder(currentOrder, projectId, direction);
    setProjectOrder(nextOrder);
    const nextVisibleProjects = filterProjectOptions(orderProjects(projects, nextOrder), query);
    const nextVisibleIndex = nextVisibleProjects.findIndex((project) => project.id === projectId);
    if (nextVisibleIndex >= 0) setHighlightedIndex(nextVisibleIndex);
  };

  const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const action = resolveProjectSwitcherKeyAction(event.key, highlightedIndex, filteredProjects.length);
    if (action.type === 'none') return;
    event.preventDefault();
    if (action.type === 'close') {
      close(true);
    } else if (action.type === 'highlight') {
      setHighlightedIndex(action.index);
    } else if (action.type === 'select') {
      const project = filteredProjects[action.index];
      if (project) selectProject(project);
    }
  };

  const startEditing = (project: Project) => {
    setIsCreating(false);
    setEditingProjectId(project.id);
    setEditLocalPath(project.localPath || '');
    setEditTaskIdPrefix(project.taskIdPrefix || '');
  };

  const saveEdit = async () => {
    if (!editingProjectId) return;
    const success = await onUpdateProject(editingProjectId, {
      localPath: editLocalPath,
      taskIdPrefix: editTaskIdPrefix.trim().toUpperCase() || undefined,
    });
    if (success) setEditingProjectId(null);
  };

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    const success = await onCreateProject(
      createForm.name.trim(),
      createForm.repoUrl.trim(),
      createForm.description.trim() || undefined,
      createForm.localPath.trim() || undefined,
      createForm.taskIdPrefix.trim().toUpperCase() || undefined,
    );
    if (success) {
      setCreateForm(emptyCreateForm);
      setIsCreating(false);
      setQuery('');
    }
  };

  const popover = open && popoverLayout ? (
    <div
      ref={panelRef}
      id="project-switcher-popover"
      role="dialog"
      aria-label="Project workspace switcher"
      className={`${PROJECT_SWITCHER_POPOVER_CLASS} flex flex-col overflow-hidden rounded-2xl border border-df-border bg-df-surface-raised shadow-[var(--df-shadow-lg)]`}
      style={{
        left: `${popoverLayout.left}px`,
        top: `${popoverLayout.top}px`,
        width: `${popoverLayout.width}px`,
        maxHeight: `${popoverLayout.maxHeight}px`,
      }}
    >
      <div className="shrink-0 border-b border-df-border p-3">
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-[0.14em] text-df-accent">Project workspace</p>
            <p className="mt-0.5 truncate text-[10px] text-df-text-muted">Switch, order, or configure project bindings.</p>
          </div>
          <button
            type="button"
            onClick={() => close(true)}
            aria-label="Close project switcher"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-df-text-muted hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
          >
            <X size={14} />
          </button>
        </div>
        {!isCreating && !editingProjectId && (
          <label className="mt-3 flex items-center gap-2 rounded-xl border border-df-border bg-df-surface px-3 py-2 focus-within:ring-2 focus-within:ring-[var(--df-color-focus-ring)]">
            <Search size={14} className="shrink-0 text-df-text-muted" />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder="Search name, repository, or local path…"
              aria-label="Search projects"
              aria-controls="project-switcher-options"
              className="min-w-0 flex-1 bg-transparent text-[11px] text-df-text outline-none placeholder:text-df-text-muted"
            />
          </label>
        )}
      </div>

      {!isCreating && !editingProjectId && (
        <div id="project-switcher-options" role="listbox" aria-label="Projects" className="min-h-0 flex-1 overflow-y-auto p-2">
          {filteredProjects.length === 0 ? (
            <p className="px-3 py-8 text-center text-[11px] text-df-text-muted">No projects match “{query}”.</p>
          ) : filteredProjects.map((project, index) => {
            const active = project.id === activeProjectId;
            const highlighted = index === highlightedIndex;
            const orderIndex = orderedProjects.findIndex((item) => item.id === project.id);
            return (
              <div
                key={project.id}
                className={`group mb-1 flex min-w-0 items-stretch gap-1 rounded-xl border p-1 transition-colors ${
                  active
                    ? 'border-[var(--df-color-border-strong)] bg-df-surface-muted'
                    : highlighted
                      ? 'border-df-border bg-df-surface'
                      : 'border-transparent hover:border-df-border hover:bg-df-surface-muted'
                }`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setHighlightedIndex(index)}
                  onClick={() => selectProject(project)}
                  className="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-df-text" title={project.name}>{project.name}</span>
                    {active && <Check size={13} className="shrink-0 text-df-accent" />}
                  </span>
                  <span className="mt-1 block truncate text-[9px] font-mono text-df-text-muted" title={project.repoUrl || undefined}>
                    {formatProjectRepoLabel(project.repoUrl)}
                  </span>
                  <span className="mt-0.5 block truncate text-[9px] font-mono text-[var(--df-color-text-subtle)]" title={project.localPath || undefined}>
                    {project.localPath || 'No local path configured'}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5 pr-1">
                  <button
                    type="button"
                    aria-label={`Move ${project.name} up`}
                    title={`Move ${project.name} up`}
                    disabled={orderIndex <= 0}
                    onClick={() => moveProject(project.id, -1)}
                    className="rounded-lg p-1.5 text-df-text-muted hover:bg-df-surface-raised hover:text-df-accent disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <ArrowUp size={12} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${project.name} down`}
                    title={`Move ${project.name} down`}
                    disabled={orderIndex < 0 || orderIndex >= orderedProjects.length - 1}
                    onClick={() => moveProject(project.id, 1)}
                    className="rounded-lg p-1.5 text-df-text-muted hover:bg-df-surface-raised hover:text-df-accent disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <ArrowDown size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => startEditing(project)}
                    title={`Edit ${project.name}`}
                    aria-label={`Edit ${project.name}`}
                    className="rounded-lg p-1.5 text-df-text-muted hover:bg-df-surface-raised hover:text-df-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => setProjectToDelete(project.id)}
                    title={`Delete ${project.name}`}
                    aria-label={`Delete ${project.name}`}
                    className="rounded-lg p-1.5 text-df-text-muted hover:bg-[var(--df-color-danger-surface)] hover:text-df-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingProjectId && (() => {
        const project = projects.find((item) => item.id === editingProjectId);
        if (!project) return null;
        return (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
            <div className="min-w-0">
              <p className="truncate text-[11px] font-extrabold text-df-text" title={project.name}>Edit {project.name}</p>
              <p className="mt-0.5 truncate text-[9px] font-mono text-df-text-muted" title={project.repoUrl || undefined}>{formatProjectRepoLabel(project.repoUrl)}</p>
            </div>
            <input value={editLocalPath} onChange={(event) => setEditLocalPath(event.target.value)} placeholder="Local absolute path" aria-label="Local absolute path" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] font-mono text-df-text outline-none focus:border-df-accent" />
            <input value={editTaskIdPrefix} onChange={(event) => setEditTaskIdPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="Task ID prefix" aria-label="Task ID prefix" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] font-mono text-df-text outline-none focus:border-df-accent" />
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEditingProjectId(null)} className="rounded-lg border border-df-border px-3 py-2 text-[10px] font-bold text-df-text-muted hover:bg-df-surface-muted">Cancel</button>
              <button type="button" onClick={saveEdit} className="rounded-lg bg-df-primary px-3 py-2 text-[10px] font-bold text-[var(--df-color-primary-text)] hover:bg-[var(--df-color-primary-hover)]">Save</button>
            </div>
          </div>
        );
      })()}

      {isCreating && (
        <form onSubmit={createProject} className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-4">
          <p className="text-[11px] font-extrabold text-df-text">Bind new repository</p>
          <input required value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))} placeholder="Project name" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] text-df-text outline-none focus:border-df-accent" />
          <input required type="url" value={createForm.repoUrl} onChange={(event) => setCreateForm((current) => ({ ...current, repoUrl: event.target.value }))} placeholder="Git repository URL" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] font-mono text-df-text outline-none focus:border-df-accent" />
          <input value={createForm.description} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} placeholder="Description (optional)" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] text-df-text outline-none focus:border-df-accent" />
          <input value={createForm.localPath} onChange={(event) => setCreateForm((current) => ({ ...current, localPath: event.target.value }))} placeholder="Local path (optional)" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] font-mono text-df-text outline-none focus:border-df-accent" />
          <input value={createForm.taskIdPrefix} onChange={(event) => setCreateForm((current) => ({ ...current, taskIdPrefix: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }))} placeholder="Task ID prefix (optional)" className="w-full rounded-xl border border-df-border bg-df-surface px-3 py-2 text-[10px] font-mono text-df-text outline-none focus:border-df-accent" />
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setIsCreating(false)} className="rounded-lg border border-df-border px-3 py-2 text-[10px] font-bold text-df-text-muted hover:bg-df-surface-muted">Cancel</button>
            <button type="submit" className="rounded-lg bg-df-primary px-3 py-2 text-[10px] font-bold text-[var(--df-color-primary-text)] hover:bg-[var(--df-color-primary-hover)]">Create project</button>
          </div>
        </form>
      )}

      {!isCreating && !editingProjectId && (
        <div className="flex shrink-0 items-center justify-between gap-2 border-t border-df-border px-3 py-2.5">
          <span className="min-w-0 truncate text-[9px] font-mono text-df-text-muted">↑↓ navigate · Enter select · Esc close</span>
          <button type="button" onClick={() => { setIsCreating(true); setQuery(''); }} className="flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-extrabold text-df-accent hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
            <Plus size={12} /> New project
          </button>
        </div>
      )}
    </div>
  ) : null;

  return (
    <div ref={rootRef} className="relative min-w-0 max-w-full">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="project-switcher-popover"
        onClick={() => {
          if (open) {
            close(false);
            return;
          }
          updatePopoverLayout();
          setOpen(true);
        }}
        className="flex min-h-11 w-full min-w-0 max-w-full items-center gap-3 rounded-xl border border-df-border bg-df-surface-raised px-3 py-2 text-left shadow-[var(--df-shadow-sm)] transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)] sm:min-w-[280px]"
        title={[activeProject?.name, activeProject?.repoUrl, activeProject?.localPath].filter(Boolean).join('\n')}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-df-surface-muted text-df-accent">
          <FolderGit size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-black text-df-text">
            {activeProject?.name || 'Select project'}
          </span>
          <span className="mt-0.5 block truncate text-[9px] font-mono text-df-text-muted">
            {activeProject ? formatProjectRepoLabel(activeProject.repoUrl) : 'No active workspace'}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-df-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {typeof document !== 'undefined' && popover ? createPortal(popover, document.body) : null}

      {projectToDelete && (
        <ConfirmModal
          title="Delete Project"
          message={`Are you sure you want to delete project “${projects.find((project) => project.id === projectToDelete)?.name || projectToDelete}” and all its tasks? This action cannot be undone.`}
          onConfirm={async () => {
            await onDeleteProject(projectToDelete);
            setProjectToDelete(null);
          }}
          onCancel={() => setProjectToDelete(null)}
          confirmText="Delete"
        />
      )}
    </div>
  );
}
