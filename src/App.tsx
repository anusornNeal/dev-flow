/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { Cat } from 'lucide-react';
import { Task, TaskStatus, LogEntry, Project } from './types';
import { isValidTransition, getValidationErrorMessage } from './lib/statusTransitions';
import { buildTaskStatusMoveRequest } from './lib/taskStatusMove';
import { useProjectViewModel } from './viewModels/useProjectViewModel';
import { useBoardViewModel } from './viewModels/useBoardViewModel';
import { apiClient } from './client/apiClient';
import { subscribeServerEvents } from './lib/serverEvents';
import Sidebar from './components/Sidebar';
import TaskDetailsDrawer from './components/TaskDetailsDrawer';
import CreateTaskModal from './components/CreateTaskModal';
import SkillsModal from './components/SkillsModal';
import SettingsModal from './components/SettingsModal';
import TemplateModal from './components/TemplateModal';
import ObservabilityModal from './components/ObservabilityModal';
import { Header } from './components/Header';
import ProjectSwitcher from './components/ProjectSwitcher';
import { BoardLane } from './components/BoardLane';
import UiPreviewLibraryPage from './components/UiPreviewLibraryPage';
import AgentOfficePage from './components/AgentOfficePage';
import type { UiPreviewLinkedTask } from './client/uiPreviewClient';
import BatchImportModal from './components/BatchImportModal';
import ConfirmModal from './components/ConfirmModal';
import TaskMoveBlockerDialog, { type TaskMoveDecision } from './components/TaskMoveBlockerDialog';
import AgentRunLogModal from './components/AgentRunLogModal';
import { BOARD_COLUMNS } from './app/boardColumns';
import { filterBoardTasks } from './app/taskFilters';
import { useActiveProjectBootstrap } from './app/useActiveProjectBootstrap';
import { useAppTheme } from './app/useAppTheme';
import {
  SIDEBAR_LAYOUT_STORAGE_KEY,
  clampSidebarWidth,
  resolveInitialSidebarLayout,
  serializeSidebarLayoutPreference,
} from './components/layout/appShellLayout';

export default function App() {
  const projectsViewModel = useProjectViewModel();
  const projects = projectsViewModel.projects as unknown as Project[];
  const { activeProjectId, setActiveProjectId } = useActiveProjectBootstrap(projects, projectsViewModel);

  const boardViewModel = useBoardViewModel({
    projectId: activeProjectId || null,
  });
  const tasks = boardViewModel.tasks as unknown as Task[];
  const setTasks = boardViewModel.setTasks as unknown as (u: (prev: Task[]) => Task[]) => void;

  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedOverColumn, setDraggedOverColumn] = useState<TaskStatus | null>(null);
  const [pendingMoveDecision, setPendingMoveDecision] = useState<{
    sourceTask: Task;
    status: TaskStatus;
    decision: TaskMoveDecision;
  } | null>(null);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);


  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isSkillsModalOpen, setIsSkillsModalOpen] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isObservabilityModalOpen, setIsObservabilityModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [logModal, setLogModal] = useState<{
    taskDisplayId: string;
    runId: string;
    runStatus?: string;
    agent?: string | null;
    model?: string | null;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  const resolveActivePage = (hash: string): 'board' | 'previews' | 'agent-office' =>
    hash === '#previews' ? 'previews' : hash === '#agent-office' ? 'agent-office' : 'board';
  const [activePage, setActivePage] = useState<'board' | 'previews' | 'agent-office'>(() => resolveActivePage(window.location.hash));
  const [sidebarLayout, setSidebarLayout] = useState(() =>
    resolveInitialSidebarLayout(window.localStorage, window.innerWidth)
  );
  
  const { theme, setTheme } = useAppTheme();
  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, serializeSidebarLayoutPreference(sidebarLayout));
    } catch {
      // Layout preferences are best-effort only.
    }
  }, [sidebarLayout]);

  const toggleSidebarCollapsed = () => {
    setSidebarLayout((current) => ({ ...current, collapsed: !current.collapsed }));
  };

  const updateSidebarWidth = (width: number) => {
    setSidebarLayout((current) => ({ ...current, width: clampSidebarWidth(width) }));
  };


  useEffect(() => {
    const syncPageFromHash = () => {
      if (window.location.hash === '#atlas') {
        window.history.replaceState('', document.title, window.location.pathname + window.location.search);
        setActivePage('board');
        return;
      }
      setActivePage(resolveActivePage(window.location.hash));
    };
    syncPageFromHash();
    window.addEventListener('hashchange', syncPageFromHash);
    return () => window.removeEventListener('hashchange', syncPageFromHash);
  }, []);

  const handleSetActivePage = (page: 'board' | 'previews' | 'agent-office') => {
    setSelectedTask(null);
    setActivePage(page);
    const hash = page === 'previews' ? 'previews' : page === 'agent-office' ? 'agent-office' : '';
    if (hash) {
      if (window.location.hash !== `#${hash}`) window.location.hash = hash;
      return;
    }
    if (window.location.hash) window.history.pushState('', document.title, window.location.pathname + window.location.search);
  };

  // Filter States
  const [selectedPriority, setSelectedPriority] = useState<Task['priority'] | 'all'>('all');
  const [selectedTag, setSelectedTag] = useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // 0. Load projects from REST API (delegated to projectRepository / useProjectViewModel)
  const fetchProjectsFromApi = async () => {
    try {
      await projectsViewModel.refresh();
      setPersistenceError(null);
      const list = projectsViewModel.projects;
      if (list.length > 0) {
        const currentId = projectsViewModel.activeProjectId;
        const isValidId = list.some((p) => p.id === currentId);
        setActiveProjectId(isValidId ? currentId : list[0].id);
      }
    } catch (err) {
      console.warn('Backend projects API connection unavailable:', err);
      setPersistenceError('Project data is unavailable because the backend could not be reached. No local fallback was used.');
    }
  };

  const handleCreateProject = async (name: string, repoUrl: string, description?: string, localPath?: string, taskIdPrefix?: string) => {
    try {
      const { data: newProj } = await apiClient.fetchJson<any>('POST', '/api/projects', { name, repoUrl, description, localPath, taskIdPrefix });
      await projectsViewModel.refresh();
      setActiveProjectId(newProj.id);
      return true;
    } catch (err) {
      console.error('Failed to create project:', err);
      setPersistenceError('Project creation failed before the backend confirmed persistence.');
    }
    return false;
  };

  const handleDeleteProject = async (id: string) => {
    try {
      await apiClient.fetchJson('DELETE', `/api/projects/${encodeURIComponent(id)}`);
      const remainingProjects = projectsViewModel.projects.filter(p => p.id !== id);
      await projectsViewModel.refresh();
      const currentId = projectsViewModel.activeProjectId;
      if (currentId === id) {
        setActiveProjectId(remainingProjects.length > 0 ? remainingProjects[0].id : null);
      }
      return true;
    } catch (err) {
      console.error('Failed to delete project:', err);
      setPersistenceError('Project deletion failed before the backend confirmed persistence.');
    }
    return false;
  };

  const handleUpdateProject = async (id: string, updates: Partial<Project>) => {
    try {
      await apiClient.fetchJson('PUT', `/api/projects/${encodeURIComponent(id)}`, updates);
      await projectsViewModel.refresh();
      return true;
    } catch (err) {
      console.error('Failed to update project:', err);
      setPersistenceError('Project update failed before the backend confirmed persistence.');
    }
    return false;
  };

  useEffect(() => {
    let fallbackTimer: number | null = null;
    const stopFallback = () => {
      if (fallbackTimer === null) return;
      window.clearInterval(fallbackTimer);
      fallbackTimer = null;
    };
    const runFallback = () => {
      void boardViewModel.refresh();
      void projectsViewModel.refresh();
    };
    const startFallback = () => {
      if (fallbackTimer !== null) return;
      fallbackTimer = window.setInterval(runFallback, 60_000);
    };

    const unsubscribe = subscribeServerEvents((event) => {
      const affectsActiveProject = !event.projectId || event.projectId === activeProjectId;
      if (event.type === 'stream.reset') {
        runFallback();
        return;
      }
      if (event.type === 'task.changed' && affectsActiveProject) void boardViewModel.refresh();
      if (event.type === 'project.changed') void projectsViewModel.refresh();
    }, {
      onAvailable: stopFallback,
      onUnavailable: startFallback,
    });
    startFallback();

    return () => {
      unsubscribe();
      stopFallback();
    };
  }, [activeProjectId, boardViewModel.refresh, projectsViewModel.refresh]);

  useEffect(() => {
    setMounted(true);
    fetchProjectsFromApi();
  }, []);

  // Handle Drag Start
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedTaskId(id);
    e.dataTransfer.setData('text/plain', id);
  };

  const executeTaskMove = async (sourceTask: Task, status: TaskStatus, manualOverride = false) => {
    const taskId = sourceTask.id;
    const modifiedLogs: LogEntry[] = [
      ...(sourceTask.logs || []),
      {
        id: `log-move-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Moved card from ${sourceTask.status.toUpperCase()} to ${status.toUpperCase()} lane`,
        type: 'move'
      }
    ];

    const updatedTask = {
      ...sourceTask,
      status,
      logs: modifiedLogs,
      updatedAt: new Date().toISOString()
    };

    // Track the pending move inside the Board view model so polling preserves the optimistic lane.
    boardViewModel.setTaskPending(taskId, true);

    // Optimistic fast update
    setTasks(prev => prev.map(task => 
      task.id === taskId 
        ? updatedTask
        : task
    ));

    // Update opened drawer if active
    if (selectedTask && selectedTask.id === taskId) {
      setSelectedTask(updatedTask);
    }

    setDraggedTaskId(null);
    setDraggedOverColumn(null);

    // Sync API update
    try {
      const moveRequest = buildTaskStatusMoveRequest(taskId, status, { intent: 'manual', manualOverride });
      const response = await fetch(moveRequest.url, moveRequest.init);
      const responseData = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTasks(prev => prev.map(task => task.id === taskId ? sourceTask : task));
        if (selectedTask && selectedTask.id === taskId) setSelectedTask(sourceTask);
        const blockers = Array.isArray(responseData.blockers) ? responseData.blockers : [];
        if (blockers.length > 0) {
          setPendingMoveDecision({
            sourceTask,
            status,
            decision: { ...responseData, blockers },
          });
          setPersistenceError(null);
          return;
        }
        setPersistenceError(responseData.message || responseData.error || `Lane move failed with status ${response.status}`);
        return;
      }
      const persistedTask = responseData.task || responseData;
      setTasks(prev => prev.map(task =>
        task.id === taskId
          ? persistedTask
          : task
      ));
      if (selectedTask && selectedTask.id === taskId) {
        setSelectedTask(persistedTask);
      }
      setPersistenceError(null);
    } catch (err) {
      console.error('API lane move sync failed:', err);
      setTasks(prev => prev.map(task => task.id === taskId ? sourceTask : task));
      if (selectedTask && selectedTask.id === taskId) setSelectedTask(sourceTask);
      setPersistenceError('Lane move could not reach the backend. The card was restored to its previous lane.');
    } finally {
      // Clear pending move whether success or failure.
      boardViewModel.setTaskPending(taskId, false);
    }
  };

  // Handle Drag Drops
  const handleDrop = async (e: React.DragEvent, status: TaskStatus) => {
    e.preventDefault();
    const taskId = draggedTaskId || e.dataTransfer.getData('text/plain');
    if (!taskId) return;

    const sourceTask = tasks.find(t => t.id === taskId);
    if (!sourceTask) return;

    // Prevent duplicate logs if same lane dropped
    if (sourceTask.status === status) {
      setDraggedTaskId(null);
      setDraggedOverColumn(null);
      return;
    }

    if (!isValidTransition(sourceTask.status, status)) {
      setPersistenceError(getValidationErrorMessage(sourceTask.status, status));
      setDraggedTaskId(null);
      setDraggedOverColumn(null);
      return;
    }

    await executeTaskMove(sourceTask, status);
  };

  const handleCreateTask = async (newTaskProps: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => {
    // Post to API
    const activeProject = projects.find(p => p.id === activeProjectId);
    const repoUrl = activeProject ? activeProject.repoUrl : 'https://github.com/google/ai-studio';
    const taskWithProject = {
      ...newTaskProps,
      projectId: activeProjectId,
      repo: repoUrl
    };
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskWithProject)
      });
      if (response.ok) {
        const createdTask = await response.json();
        setTasks(prev => [createdTask, ...prev]);
        setIsCreateModalOpen(false);
        setPersistenceError(null);
        return;
      }
      throw new Error(`Task creation failed with status ${response.status}`);
    } catch (err) {
      console.error('API creation failed:', err);
      setPersistenceError('Task creation failed before the backend confirmed persistence. No local fallback task was created.');
    }
  };

  const handleBatchImport = async (parsedJson: any): Promise<boolean> => {
    let rawItems = parsedJson;
    let outerRepo: string | undefined = undefined;

    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems)) {
      if (Array.isArray(rawItems.tasks)) {
        outerRepo = rawItems.repo || rawItems.repoUrl;
        rawItems = rawItems.tasks.map((taskItem: any) => {
          if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
            return { ...taskItem, repo: outerRepo };
          }
          return taskItem;
        });
      }
    }

    const finalArray = Array.isArray(rawItems) ? rawItems : [rawItems];
    const activeProject = projects.find(p => p.id === activeProjectId);
    const defaultRepo = activeProject ? activeProject.repoUrl : 'https://github.com/google/ai-studio';
    const itemsWithProject = finalArray.map((item: any) => ({
      ...item,
      projectId: item.projectId || activeProjectId,
      repo: item.repo || item.repoUrl || defaultRepo
    }));
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemsWithProject)
      });
      if (response.ok) {
        await boardViewModel.refresh();
        setIsBatchModalOpen(false);
        setPersistenceError(null);
        return true;
      }
      throw new Error(`Batch import failed with status ${response.status}`);
    } catch (err) {
      console.error('API batch creation failed:', err);
      setPersistenceError('Batch import failed before the backend confirmed persistence. No offline import fallback was applied.');
    }
    return false;
  };

  const handleUpdateTask = async (updatedTask: Task) => {
    // Optimistic UI updates
    setTasks(prev => prev.map(t => t.id === updatedTask.id ? updatedTask : t));
    if (selectedTask && selectedTask.id === updatedTask.id) {
      setSelectedTask(updatedTask);
    }

    const taskProj = projects.find(p => p.id === updatedTask.projectId);

    // Sync update to API
    try {
      const response = await fetch(`/api/tasks/${updatedTask.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...updatedTask,
          repo: taskProj ? taskProj.repoUrl : undefined
        })
      });
      if (!response.ok) {
        throw new Error(`Task update failed with status ${response.status}`);
      }
      setPersistenceError(null);
    } catch (err) {
      console.error('API modification update failed:', err);
      setPersistenceError('Task update failed before the backend confirmed persistence.');
    }
  };

  const executeDeleteTask = async (id: string) => {
    // Optimistic delete
    setTasks(prev => prev.filter(t => t.id !== id));
    if (selectedTask && selectedTask.id === id) {
      setSelectedTask(null);
    }

    // Sync deletion to API
    try {
      const response = await fetch(`/api/tasks/${id}`, {
        method: 'DELETE'
      });
      if (!response.ok) {
        throw new Error(`Task deletion failed with status ${response.status}`);
      }
      setPersistenceError(null);
    } catch (err) {
      console.error('API deletion sync failed:', err);
      setPersistenceError('Task deletion failed before the backend confirmed persistence.');
    }
  };

  const handleDeleteTask = (id: string) => {
    setTaskToDelete(id);
  };

  const filteredTasks = filterBoardTasks(tasks, {
    activeProjectId,
    selectedPriority,
    selectedTag,
    searchQuery,
  });
  const activeProject = projects.find((project) => project.id === activeProjectId);

  const handleOpenPreviewTask = async (task: UiPreviewLinkedTask) => {
    try {
      if (task.projectId && task.projectId !== activeProjectId) setActiveProjectId(task.projectId);
      const result = await apiClient.fetchJson<Task>('GET', `/api/tasks/${encodeURIComponent(task.id)}?mode=standard`);
      handleSetActivePage('board');
      setSelectedTask(result.data);
      setPersistenceError(null);
    } catch (error) {
      setPersistenceError(error instanceof Error ? `Could not open linked task: ${error.message}` : 'Could not open linked task.');
    }
  };

  const handleOpenAgentOfficeTask = async (taskId: string) => {
    try {
      const result = await apiClient.fetchJson<Task>('GET', `/api/tasks/${encodeURIComponent(taskId)}?mode=standard`);
      setSelectedTask(result.data);
      setPersistenceError(null);
    } catch (error) {
      setPersistenceError(error instanceof Error ? `Could not open monitored task: ${error.message}` : 'Could not open monitored task.');
    }
  };

  if (!mounted) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-df-canvas font-mono text-xs text-df-text-muted" role="status" aria-live="polite">
        <Cat size={40} className="animate-bounce text-df-accent" />
        <p>Starting DevFlow...</p>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-df-canvas font-sans text-df-text antialiased">
      
      {/* Mid View container with Sidebar + Board */}
      <div className="flex flex-1 overflow-y-auto lg:overflow-hidden flex-col lg:flex-row">
        
        {/* 1. Persistent navigation and board controls */}
        <Sidebar 
          tasks={tasks.filter(t => t.projectId === activeProjectId)}
          projects={projects}
          activeProjectId={activeProjectId}
          selectedPriority={selectedPriority}
          setSelectedPriority={setSelectedPriority}
          selectedTag={selectedTag}
          setSelectedTag={setSelectedTag}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
          activePage={activePage}
          onSetActivePage={handleSetActivePage}
          isCollapsed={sidebarLayout.collapsed}
          width={sidebarLayout.width}
          onToggleCollapsed={toggleSidebarCollapsed}
          onWidthChange={updateSidebarWidth}
        />

        {/* 2. Main KanBan Board viewport area */}
        <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-df-canvas">
          
          {/* Stable page context and global actions */}
          <Header
            filteredTasksCount={filteredTasks.length}
            title={activePage === 'previews' ? 'UI Previews' : activePage === 'agent-office' ? 'Agent Office' : 'Sprint Board'}
            subtitle={activePage === 'previews' ? 'Preview Library' : activePage === 'agent-office' ? 'Operations' : 'Board'}
            contextLabel={
              activePage === 'previews'
                ? 'Local design evidence across projects'
                : activePage === 'agent-office'
                  ? 'Active workers across all boards'
                  : `${filteredTasks.length} visible tasks`
            }
            projectSwitcher={activePage === 'board' ? (
              <ProjectSwitcher
                projects={projects}
                activeProjectId={activeProjectId}
                setActiveProjectId={setActiveProjectId}
                onCreateProject={handleCreateProject}
                onDeleteProject={handleDeleteProject}
                onUpdateProject={handleUpdateProject}
              />
            ) : undefined}
            showTaskActions={activePage === 'board'}
            theme={theme}
            setTheme={setTheme}
            setIsSkillsModalOpen={setIsSkillsModalOpen}
            setIsTemplateModalOpen={setIsTemplateModalOpen}
            setIsObservabilityModalOpen={setIsObservabilityModalOpen}
            setIsCreateModalOpen={setIsCreateModalOpen}
            setIsBatchModalOpen={setIsBatchModalOpen}
          />

          {persistenceError && (
            <div role="alert" className="df-feedback df-feedback--warning mx-5 mt-4 font-mono font-bold">
              Persistence warning: {persistenceError}
            </div>
          )}

          {activePage === 'agent-office' ? (
            <AgentOfficePage onOpenTask={handleOpenAgentOfficeTask} />
          ) : activePage === 'previews' ? (
            <UiPreviewLibraryPage onOpenTask={handleOpenPreviewTask} />
          ) : (
          <div className="flex-1 overflow-x-auto bg-df-canvas p-5 md:p-6">
              <div className="flex w-max items-stretch min-h-[calc(100vh-210px)] pb-2">
                {BOARD_COLUMNS.map(col => {
                  const columnTasks = filteredTasks
                    .filter(t => t.status === col.id && !t.parentId)
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                  
                  return (
                      <BoardLane
                        key={col.id}
                        column={col}
                        tasks={columnTasks}
                        allTasks={tasks}
                        totalCount={boardViewModel.lanePages[col.id].total}
                        loadedCount={boardViewModel.lanePages[col.id].loaded}
                        hasMore={boardViewModel.lanePages[col.id].hasMore}
                        loadingMore={boardViewModel.lanePages[col.id].loading}
                        onLoadMore={() => boardViewModel.loadMore(col.id)}
                        draggedOverColumn={draggedOverColumn}
                        draggedTaskId={draggedTaskId}
                        setDraggedOverColumn={setDraggedOverColumn}
                      handleDrop={handleDrop}
                      setSelectedTask={setSelectedTask}
                      handleDeleteTask={handleDeleteTask}
                      handleDragStart={handleDragStart}
                      handleUpdateTask={handleUpdateTask}
                      onShowLog={({ taskDisplayId, run }) => setLogModal({ taskDisplayId, runId: run.id, runStatus: run.status, agent: run.agent, model: run.model })}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>

      {/* Compact truthful context bar */}
      <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-df-border bg-df-surface px-4 text-[10px] font-mono font-semibold text-df-text-muted">
        <div className="min-w-0 truncate" title={activeProject?.name || undefined}>
          {activeProject ? `${activeProject.taskIdPrefix || 'Project'} · ${activeProject.name}` : 'No active project'}
        </div>
        <div className="shrink-0">
          {activePage === 'previews' ? 'UI Previews' : activePage === 'agent-office' ? 'Agent Office' : 'Sprint Board'}
        </div>
      </footer>

      {/* 3. Detail Drawer (shown on clicking a card) */}
      {selectedTask && (
        <TaskDetailsDrawer
          task={selectedTask}
          allTasks={tasks}
          onSelectTask={setSelectedTask}
          onCreateTask={handleCreateTask}
          onClose={() => setSelectedTask(null)}
          onUpdate={handleUpdateTask}
          onDelete={handleDeleteTask}
          onShowLog={(run) => setLogModal({ taskDisplayId: selectedTask.displayId || selectedTask.id, runId: run.id, runStatus: run.status, agent: run.agent, model: run.model })}
        />
      )}

      {/* 4. Task Creator Modal (triggered via commit button) */}
      {isCreateModalOpen && (
        <CreateTaskModal
          onClose={() => setIsCreateModalOpen(false)}
          onSubmit={handleCreateTask}
        />
      )}

      {/* 4.5 Batch JSON Import Modal */}
      {isBatchModalOpen && (
        <BatchImportModal
          onClose={() => setIsBatchModalOpen(false)}
          onImport={handleBatchImport}
        />
      )}

      {/* 6. Skills Modal */}
      {isSkillsModalOpen && (
        <SkillsModal
          onClose={() => setIsSkillsModalOpen(false)}
        />
      )}

      {/* 7. Template Modal */}
      {isTemplateModalOpen && (
        <TemplateModal
          onClose={() => setIsTemplateModalOpen(false)}
        />
      )}

      {/* 8. Settings Modal */}
      {isObservabilityModalOpen && (
        <ObservabilityModal onClose={() => setIsObservabilityModalOpen(false)} />
      )}
      {isSettingsModalOpen && (
        <SettingsModal onClose={() => setIsSettingsModalOpen(false)} />
      )}

      {/* 9. Actionable task move blocker dialog */}
      {pendingMoveDecision && (
        <TaskMoveBlockerDialog
          decision={pendingMoveDecision.decision}
          sourceLabel={pendingMoveDecision.sourceTask.status.replaceAll('-', ' ')}
          targetLabel={pendingMoveDecision.status.replaceAll('-', ' ')}
          onMoveAnyway={() => {
            executeTaskMove(pendingMoveDecision.sourceTask, pendingMoveDecision.status, true);
            setPendingMoveDecision(null);
          }}
          onCancel={() => setPendingMoveDecision(null)}
        />
      )}

      {/* 10. Delete Task Modal */}
      {taskToDelete && (
        <ConfirmModal
          title="Delete Task"
          message="Are you sure you want to delete this task? This action cannot be undone."
          onConfirm={() => {
            executeDeleteTask(taskToDelete);
            setTaskToDelete(null);
          }}
          onCancel={() => setTaskToDelete(null)}
          confirmText="Delete"
        />
      )}

      {/* 11. Agent Run Log Modal */}
      {logModal && (
        <AgentRunLogModal
          taskDisplayId={logModal.taskDisplayId}
          runId={logModal.runId}
          runStatus={logModal.runStatus}
          agent={logModal.agent}
          model={logModal.model}
          onClose={() => setLogModal(null)}
        />
      )}
    </div>
  );
}


