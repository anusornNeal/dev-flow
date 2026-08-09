import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Check, ChevronDown, FolderGit, Pencil, Plus, Search, Trash2, X } from 'lucide-react';
import type { Project } from '../types';
import ConfirmModal from './ConfirmModal';

export const PROJECT_SWITCHER_POPOVER_CLASS = 'absolute left-0 top-[calc(100%+8px)] z-50 w-[400px] max-w-[calc(100vw-2rem)]';

export const PROJECT_SWITCHER_ORDER_STORAGE_KEY = 'devflow.project-switcher.order.v1';

interface ProjectOrderStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
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
  const projectsLoadedRef = useRef(projects.length > 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const activeProject = projects.find((project) => project.id === activeProjectId) || projects[0];
  const orderedProjects = useMemo(() => orderProjects(projects, projectOrder), [projects, projectOrder]);
  const filteredProjects = useMemo(() => filterProjectOptions(orderedProjects, query), [orderedProjects, query]);

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
    if (!open) return;
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleOutside);
    requestAnimationFrame(() => searchRef.current?.focus());
    return () => document.removeEventListener('mousedown', handleOutside);
  }, [open]);

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query, activeProjectId]);

  const close = () => {
    setOpen(false);
    setQuery('');
    setIsCreating(false);
    setEditingProjectId(null);
  };

  const selectProject = (project: Project) => {
    setActiveProjectId(project.id);
    close();
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
      close();
      triggerRef.current?.focus();
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

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className="flex min-h-12 w-full min-w-[260px] max-w-[420px] items-center gap-3 rounded-xl border border-[#e5d4bb] bg-[#fffaf2] px-3.5 py-2 text-left shadow-xs transition-colors hover:bg-[#fff4e2] dark:border-[#584a3b] dark:bg-[#211a15] dark:hover:bg-[#2d241c] md:min-w-[300px]"
        title={[activeProject?.name, activeProject?.repoUrl, activeProject?.localPath].filter(Boolean).join('\n')}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#ffe5bf] text-[#a46c24] dark:bg-[#3a2f26] dark:text-[#e0a070]">
          <FolderGit size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] font-black text-[#4b382b] dark:text-[#f3eadf]">
            {activeProject?.name || 'Select project'}
          </span>
          <span className="mt-0.5 block truncate text-[9px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
            {activeProject ? formatProjectRepoLabel(activeProject.repoUrl) : 'No active workspace'}
          </span>
        </span>
        <ChevronDown size={14} className={`shrink-0 text-[#8a6e5a] transition-transform dark:text-[#b8ab9f] ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className={`${PROJECT_SWITCHER_POPOVER_CLASS} overflow-hidden rounded-2xl border border-[#dcc9ae] bg-[#fffefd] shadow-2xl dark:border-[#584a3b] dark:bg-[#1f1914]`}>
          <div className="border-b border-[#eadcc8] p-3 dark:border-[#4d4033]">
            <div className="flex items-center justify-between gap-2">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.14em] text-[#9a6a34] dark:text-[#e0a070]">Project workspace</p>
                <p className="mt-0.5 text-[10px] text-[#8a7565] dark:text-[#b8ab9f]">Switch quickly without squeezing project details into the sidebar.</p>
              </div>
              <button type="button" onClick={close} aria-label="Close project switcher" className="rounded-lg p-1.5 text-[#8a7565] hover:bg-[#f6ead8] dark:text-[#b8ab9f] dark:hover:bg-[#332820]">
                <X size={14} />
              </button>
            </div>
            {!isCreating && !editingProjectId && (
              <label className="mt-3 flex items-center gap-2 rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 dark:border-[#514235] dark:bg-[#261e18]">
                <Search size={14} className="shrink-0 text-[#9a806c]" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search name, repository, or local path…"
                  className="min-w-0 flex-1 bg-transparent text-[11px] text-[#4b382b] outline-none placeholder:text-[#b5a18f] dark:text-[#f3eadf]"
                />
              </label>
            )}
          </div>

          {!isCreating && !editingProjectId && (
            <div role="listbox" aria-label="Projects" className="max-h-[360px] overflow-y-auto p-2">
              {filteredProjects.length === 0 ? (
                <p className="px-3 py-8 text-center text-[11px] text-[#8a7565] dark:text-[#b8ab9f]">No projects match “{query}”.</p>
              ) : filteredProjects.map((project, index) => {
                const active = project.id === activeProjectId;
                const highlighted = index === highlightedIndex;
                const orderIndex = orderedProjects.findIndex((item) => item.id === project.id);
                return (
                  <div
                    key={project.id}
                    className={`group mb-1 flex items-stretch gap-1 rounded-xl border p-1 transition-colors ${
                      active
                        ? 'border-[#d7a45c] bg-[#fff1d8] dark:border-[#8d6738] dark:bg-[#35291f]'
                        : highlighted
                          ? 'border-[#e0c8aa] bg-[#fff8ed] dark:border-[#5c4939] dark:bg-[#2a211a]'
                          : 'border-transparent hover:border-[#ead9c3] hover:bg-[#fffaf2] dark:hover:border-[#4d4033] dark:hover:bg-[#261e18]'
                    }`}
                  >
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onMouseEnter={() => setHighlightedIndex(index)}
                      onClick={() => selectProject(project)}
                      className="min-w-0 flex-1 rounded-lg px-2.5 py-2 text-left"
                    >
                      <span className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-[11px] font-extrabold text-[#4b382b] dark:text-[#f3eadf]" title={project.name}>{project.name}</span>
                        {active && <Check size={13} className="shrink-0 text-[#b77528] dark:text-[#e0a070]" />}
                      </span>
                      <span className="mt-1 block truncate text-[9px] font-mono text-[#806b5b] dark:text-[#c8b9ab]" title={project.repoUrl || undefined}>
                        {formatProjectRepoLabel(project.repoUrl)}
                      </span>
                      <span className="mt-0.5 block truncate text-[9px] font-mono text-[#9c8878] dark:text-[#a99a8d]" title={project.localPath || undefined}>
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
                        className="rounded-lg p-1.5 text-[#8a7565] hover:bg-white hover:text-[#a46c24] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#b8ab9f] dark:hover:bg-[#3a2f26]"
                      >
                        <ArrowUp size={12} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${project.name} down`}
                        title={`Move ${project.name} down`}
                        disabled={orderIndex < 0 || orderIndex >= orderedProjects.length - 1}
                        onClick={() => moveProject(project.id, 1)}
                        className="rounded-lg p-1.5 text-[#8a7565] hover:bg-white hover:text-[#a46c24] disabled:cursor-not-allowed disabled:opacity-30 dark:text-[#b8ab9f] dark:hover:bg-[#3a2f26]"
                      >
                        <ArrowDown size={12} />
                      </button>
                      <button type="button" onClick={() => startEditing(project)} title={`Edit ${project.name}`} className="rounded-lg p-1.5 text-[#8a7565] hover:bg-white hover:text-[#a46c24] dark:text-[#b8ab9f] dark:hover:bg-[#3a2f26]">
                        <Pencil size={12} />
                      </button>
                      <button type="button" onClick={() => setProjectToDelete(project.id)} title={`Delete ${project.name}`} className="rounded-lg p-1.5 text-[#9a7565] hover:bg-[#fff0ea] hover:text-[#b75335] dark:text-[#b8ab9f] dark:hover:bg-[#3a2420]">
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
              <div className="space-y-3 p-4">
                <div>
                  <p className="text-[11px] font-extrabold text-[#4b382b] dark:text-[#f3eadf]">Edit {project.name}</p>
                  <p className="mt-0.5 truncate text-[9px] font-mono text-[#8a7565] dark:text-[#b8ab9f]" title={project.repoUrl || undefined}>{formatProjectRepoLabel(project.repoUrl)}</p>
                </div>
                <input value={editLocalPath} onChange={(event) => setEditLocalPath(event.target.value)} placeholder="Local absolute path" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] font-mono outline-none focus:border-[#d19a54] dark:border-[#514235] dark:bg-[#261e18]" />
                <input value={editTaskIdPrefix} onChange={(event) => setEditTaskIdPrefix(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))} placeholder="Task ID prefix" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] font-mono outline-none focus:border-[#d19a54] dark:border-[#514235] dark:bg-[#261e18]" />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setEditingProjectId(null)} className="rounded-lg border border-[#e4d3bd] px-3 py-2 text-[10px] font-bold dark:border-[#514235]">Cancel</button>
                  <button type="button" onClick={saveEdit} className="rounded-lg bg-[#d89745] px-3 py-2 text-[10px] font-bold text-white">Save</button>
                </div>
              </div>
            );
          })()}

          {isCreating && (
            <form onSubmit={createProject} className="space-y-2.5 p-4">
              <p className="text-[11px] font-extrabold text-[#4b382b] dark:text-[#f3eadf]">Bind new repository</p>
              <input required value={createForm.name} onChange={(event) => setCreateForm((current) => ({ ...current, name: event.target.value }))} placeholder="Project name" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] outline-none dark:border-[#514235] dark:bg-[#261e18]" />
              <input required type="url" value={createForm.repoUrl} onChange={(event) => setCreateForm((current) => ({ ...current, repoUrl: event.target.value }))} placeholder="Git repository URL" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] font-mono outline-none dark:border-[#514235] dark:bg-[#261e18]" />
              <input value={createForm.description} onChange={(event) => setCreateForm((current) => ({ ...current, description: event.target.value }))} placeholder="Description (optional)" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] outline-none dark:border-[#514235] dark:bg-[#261e18]" />
              <input value={createForm.localPath} onChange={(event) => setCreateForm((current) => ({ ...current, localPath: event.target.value }))} placeholder="Local path (optional)" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] font-mono outline-none dark:border-[#514235] dark:bg-[#261e18]" />
              <input value={createForm.taskIdPrefix} onChange={(event) => setCreateForm((current) => ({ ...current, taskIdPrefix: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) }))} placeholder="Task ID prefix (optional)" className="w-full rounded-xl border border-[#e4d3bd] bg-white px-3 py-2 text-[10px] font-mono outline-none dark:border-[#514235] dark:bg-[#261e18]" />
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setIsCreating(false)} className="rounded-lg border border-[#e4d3bd] px-3 py-2 text-[10px] font-bold dark:border-[#514235]">Cancel</button>
                <button type="submit" className="rounded-lg bg-[#d89745] px-3 py-2 text-[10px] font-bold text-white">Create project</button>
              </div>
            </form>
          )}

          {!isCreating && !editingProjectId && (
            <div className="flex items-center justify-between gap-2 border-t border-[#eadcc8] px-3 py-2.5 dark:border-[#4d4033]">
              <span className="text-[9px] font-mono text-[#9a8879] dark:text-[#9f9185]">↑↓ navigate · Enter select · Esc close</span>
              <button type="button" onClick={() => { setIsCreating(true); setQuery(''); }} className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[10px] font-extrabold text-[#a46c24] hover:bg-[#fff1d8] dark:text-[#e0a070] dark:hover:bg-[#35291f]">
                <Plus size={12} /> New project
              </button>
            </div>
          )}
        </div>
      )}

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
