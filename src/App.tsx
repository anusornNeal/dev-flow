/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Cat } from 'lucide-react';
import type { Project, Task } from './types';
import { useProjectViewModel } from './viewModels/useProjectViewModel';
import { useBoardViewModel } from './viewModels/useBoardViewModel';
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
import BatchImportModal from './components/BatchImportModal';
import ConfirmModal from './components/ConfirmModal';
import TaskMoveBlockerDialog from './components/TaskMoveBlockerDialog';
import AgentRunLogModal from './components/AgentRunLogModal';
import { BOARD_COLUMNS } from './app/boardColumns';
import { filterBoardTasks } from './app/taskFilters';
import { useActiveProjectBootstrap } from './app/useActiveProjectBootstrap';
import { useAppTheme } from './app/useAppTheme';
import { useAppNavigation } from './app/useAppNavigation';
import { useProjectActions } from './app/useProjectActions';
import { useBoardTaskActions } from './app/useBoardTaskActions';
import { useServerRefresh } from './app/useServerRefresh';
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
  const boardViewModel = useBoardViewModel({ projectId: activeProjectId || null });
  const tasks = boardViewModel.tasks as unknown as Task[];
  const setTasks = boardViewModel.setTasks as unknown as (update: (previous: Task[]) => Task[]) => void;

  const [persistenceError, setPersistenceError] = useState<string | null>(null);
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
  const [sidebarLayout, setSidebarLayout] = useState(() =>
    resolveInitialSidebarLayout(window.localStorage, window.innerWidth),
  );
  const [selectedPriority, setSelectedPriority] = useState<Task['priority'] | 'all'>('all');
  const [selectedTag, setSelectedTag] = useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const { theme, setTheme } = useAppTheme();
  const projectActions = useProjectActions({ projectsViewModel, setActiveProjectId, setPersistenceError });
  const navigation = useAppNavigation({ activeProjectId, setActiveProjectId, setSelectedTask, setPersistenceError });
  const taskActions = useBoardTaskActions({
    projects,
    activeProjectId,
    tasks,
    setTasks,
    selectedTask,
    setSelectedTask,
    setPersistenceError,
    setIsCreateModalOpen,
    setIsBatchModalOpen,
    refreshBoard: boardViewModel.refresh,
    setTaskPending: boardViewModel.setTaskPending,
  });
  useServerRefresh({
    activeProjectId,
    refreshBoard: boardViewModel.refresh,
    refreshProjects: projectsViewModel.refresh,
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_LAYOUT_STORAGE_KEY, serializeSidebarLayoutPreference(sidebarLayout));
    } catch {
      // Layout preferences are best-effort only.
    }
  }, [sidebarLayout]);

  useEffect(() => {
    setMounted(true);
    void projectActions.refreshProjects();
  }, []);

  const toggleSidebarCollapsed = () => {
    setSidebarLayout((current) => ({ ...current, collapsed: !current.collapsed }));
  };

  const updateSidebarWidth = (width: number) => {
    setSidebarLayout((current) => ({ ...current, width: clampSidebarWidth(width) }));
  };

  const filteredTasks = filterBoardTasks(tasks, {
    activeProjectId,
    selectedPriority,
    selectedTag,
    searchQuery,
  });
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const activePage = navigation.activePage;

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
      <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <Sidebar
          tasks={tasks.filter((task) => task.projectId === activeProjectId)}
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
          onSetActivePage={navigation.setPage}
          isCollapsed={sidebarLayout.collapsed}
          width={sidebarLayout.width}
          onToggleCollapsed={toggleSidebarCollapsed}
          onWidthChange={updateSidebarWidth}
        />

        <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto bg-df-canvas">
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
                onCreateProject={projectActions.createProject}
                onDeleteProject={projectActions.deleteProject}
                onUpdateProject={projectActions.updateProject}
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
            <AgentOfficePage onOpenTask={navigation.openAgentOfficeTask} />
          ) : activePage === 'previews' ? (
            <UiPreviewLibraryPage onOpenTask={navigation.openPreviewTask} />
          ) : (
            <div className="flex-1 overflow-x-auto bg-df-canvas p-5 md:p-6">
              <div className="flex min-h-[calc(100vh-210px)] w-max items-stretch pb-2">
                {BOARD_COLUMNS.map((column) => {
                  const columnTasks = filteredTasks
                    .filter((task) => task.status === column.id && !task.parentId)
                    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

                  return (
                    <BoardLane
                      key={column.id}
                      column={column}
                      tasks={columnTasks}
                      allTasks={tasks}
                      totalCount={boardViewModel.lanePages[column.id].total}
                      loadedCount={boardViewModel.lanePages[column.id].loaded}
                      hasMore={boardViewModel.lanePages[column.id].hasMore}
                      loadingMore={boardViewModel.lanePages[column.id].loading}
                      onLoadMore={() => boardViewModel.loadMore(column.id)}
                      draggedOverColumn={taskActions.draggedOverColumn}
                      draggedTaskId={taskActions.draggedTaskId}
                      setDraggedOverColumn={taskActions.setDraggedOverColumn}
                      handleDrop={taskActions.handleDrop}
                      setSelectedTask={setSelectedTask}
                      handleDeleteTask={taskActions.setTaskToDelete}
                      handleDragStart={taskActions.handleDragStart}
                      handleUpdateTask={taskActions.updateTask}
                      onShowLog={({ taskDisplayId, run }) => setLogModal({
                        taskDisplayId,
                        runId: run.id,
                        runStatus: run.status,
                        agent: run.agent,
                        model: run.model,
                      })}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </main>
      </div>

      <footer className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-df-border bg-df-surface px-4 text-[10px] font-mono font-semibold text-df-text-muted">
        <div className="min-w-0 truncate" title={activeProject?.name || undefined}>
          {activeProject ? `${activeProject.taskIdPrefix || 'Project'} · ${activeProject.name}` : 'No active project'}
        </div>
        <div className="shrink-0">
          {activePage === 'previews' ? 'UI Previews' : activePage === 'agent-office' ? 'Agent Office' : 'Sprint Board'}
        </div>
      </footer>

      {selectedTask && (
        <TaskDetailsDrawer
          task={selectedTask}
          allTasks={tasks}
          onSelectTask={setSelectedTask}
          onCreateTask={taskActions.createTask}
          onClose={() => setSelectedTask(null)}
          onUpdate={taskActions.updateTask}
          onDelete={taskActions.setTaskToDelete}
          onShowLog={(run) => setLogModal({
            taskDisplayId: selectedTask.displayId || selectedTask.id,
            runId: run.id,
            runStatus: run.status,
            agent: run.agent,
            model: run.model,
          })}
        />
      )}

      {isCreateModalOpen && (
        <CreateTaskModal onClose={() => setIsCreateModalOpen(false)} onSubmit={taskActions.createTask} />
      )}

      {isBatchModalOpen && (
        <BatchImportModal onClose={() => setIsBatchModalOpen(false)} onImport={taskActions.batchImport} />
      )}

      {isSkillsModalOpen && <SkillsModal onClose={() => setIsSkillsModalOpen(false)} />}
      {isTemplateModalOpen && <TemplateModal onClose={() => setIsTemplateModalOpen(false)} />}
      {isObservabilityModalOpen && <ObservabilityModal onClose={() => setIsObservabilityModalOpen(false)} />}
      {isSettingsModalOpen && <SettingsModal onClose={() => setIsSettingsModalOpen(false)} />}

      {taskActions.pendingMoveDecision && (
        <TaskMoveBlockerDialog
          decision={taskActions.pendingMoveDecision.decision}
          sourceLabel={taskActions.pendingMoveDecision.sourceTask.status.replaceAll('-', ' ')}
          targetLabel={taskActions.pendingMoveDecision.status.replaceAll('-', ' ')}
          onMoveAnyway={() => {
            void taskActions.executeTaskMove(
              taskActions.pendingMoveDecision!.sourceTask,
              taskActions.pendingMoveDecision!.status,
              true,
            );
            taskActions.setPendingMoveDecision(null);
          }}
          onCancel={() => taskActions.setPendingMoveDecision(null)}
        />
      )}

      {taskActions.taskToDelete && (
        <ConfirmModal
          title="Delete Task"
          message="Are you sure you want to delete this task? This action cannot be undone."
          onConfirm={() => {
            void taskActions.deleteTask(taskActions.taskToDelete!);
            taskActions.setTaskToDelete(null);
          }}
          onCancel={() => taskActions.setTaskToDelete(null)}
          confirmText="Delete"
        />
      )}

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
