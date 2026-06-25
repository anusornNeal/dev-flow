/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Cat } from 'lucide-react';
import { Task, TaskStatus, LogEntry, Project } from './types';
import { isValidTransition, getValidationErrorMessage } from './lib/statusTransitions';
import { buildTaskStatusMoveRequest } from './lib/taskStatusMove';
import { useProjectViewModel } from './viewModels/useProjectViewModel';
import { useBoardViewModel } from './viewModels/useBoardViewModel';
import { apiClient } from './client/apiClient';
import Sidebar from './components/Sidebar';
import TaskDetailsDrawer from './components/TaskDetailsDrawer';
import CreateTaskModal from './components/CreateTaskModal';
import JsonTemplateModal from './components/JsonTemplateModal';
import SkillsModal from './components/SkillsModal';
import SettingsModal from './components/SettingsModal';
import TemplateModal from './components/TemplateModal';
import ObservabilityModal from './components/ObservabilityModal';
import { Header } from './components/Header';
import { BoardLane } from './components/BoardLane';
import BatchImportModal from './components/BatchImportModal';
import ConfirmModal from './components/ConfirmModal';
import AgentRunLogModal from './components/AgentRunLogModal';
import { BOARD_COLUMNS } from './app/boardColumns';
import { filterBoardTasks } from './app/taskFilters';
import { useActiveProjectBootstrap } from './app/useActiveProjectBootstrap';
import { useAppTheme } from './app/useAppTheme';

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
  const [pendingEmergencyMove, setPendingEmergencyMove] = useState<{ sourceTask: Task, status: TaskStatus } | null>(null);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);

  // Ref to track tasks currently moving to prevent polling race conditions
  const pendingMovesRef = useRef<Set<string>>(new Set());

  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isJsonModalOpen, setIsJsonModalOpen] = useState(false);
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
  const [ngrokUrl, setNgrokUrl] = useState('');
  
  const { theme, setTheme } = useAppTheme();

  // Filter States
  const [selectedPriority, setSelectedPriority] = useState<Task['priority'] | 'all'>('all');
  const [selectedTag, setSelectedTag] = useState<string | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // 0. Load settings from REST API (GET /api/settings)
  const fetchSettingsFromApi = async () => {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setNgrokUrl(data.ngrokUrl ?? '');
      }
    } catch (err) {
      console.warn('Failed to fetch settings:', err);
    }
  };

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
    setMounted(true);
    fetchSettingsFromApi();
    fetchProjectsFromApi();
  }, []);

  // Handle Drag Start
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedTaskId(id);
    e.dataTransfer.setData('text/plain', id);
  };

  const executeTaskMove = async (sourceTask: Task, status: TaskStatus) => {
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

    // Track the pending move
    pendingMovesRef.current.add(taskId);

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
      const isEmergency = sourceTask.status === 'in-progress';
      const moveRequest = buildTaskStatusMoveRequest(taskId, status, { emergency: isEmergency });
      const response = await fetch(moveRequest.url, moveRequest.init);
      if (!response.ok) {
        throw new Error(`Lane move failed with status ${response.status}`);
      }
      const responseData = await response.json();
      const persistedTask = responseData.task || responseData;
      setTasks(prev => prev.map(task =>
        task.id === taskId
          ? persistedTask
          : task
      ));
      if (selectedTask && selectedTask.id === taskId) {
        setSelectedTask(persistedTask);
      }
      const autoWorkTrigger = responseData.autoWorkTrigger;
      if (autoWorkTrigger && autoWorkTrigger.triggered === false && autoWorkTrigger.reason) {
        const warningMessage = `Auto Work blocked before launch: ${autoWorkTrigger.reason}`;
        setPersistenceError(warningMessage);
        window.dispatchEvent(new CustomEvent('devflow:auto-work-preflight-error', {
          detail: {
            code: autoWorkTrigger.code || 'UNKNOWN',
            message: warningMessage,
          },
        }));
      } else {
        setPersistenceError(null);
      }
    } catch (err) {
      console.error('API lane move sync failed:', err);
      setPersistenceError('Lane move was shown optimistically, but backend persistence failed. Refresh after backend recovery to confirm final state.');
    } finally {
      // Clear pending move whether success or failure
      pendingMovesRef.current.delete(taskId);
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

    if (sourceTask.status === 'in-progress') {
      setPendingEmergencyMove({ sourceTask, status });
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

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#faf6ef] dark:bg-[#292119] flex flex-col items-center justify-center text-[#8a6e5a] dark:text-[#f3eadf] font-mono text-xs gap-3">
        <Cat size={40} className="text-[#d89745] dark:text-[#e0a070] animate-bounce" />
        <p>Starting DevFlow...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fcfaf4] dark:bg-[#1e1914] text-[#3e3129] dark:text-[#f3eadf] font-sans antialiased overflow-hidden select-none">
      
      {/* Mid View container with Sidebar + Board */}
      <div className="flex flex-1 overflow-hidden flex-col lg:flex-row">
        
        {/* 1. Left Filters & Stats Sidemenu Section */}
        <Sidebar 
          tasks={tasks.filter(t => t.projectId === activeProjectId)}
          projects={projects}
          activeProjectId={activeProjectId}
          setActiveProjectId={setActiveProjectId}
          onCreateProject={handleCreateProject}
          onDeleteProject={handleDeleteProject}
          onUpdateProject={handleUpdateProject}
          selectedPriority={selectedPriority}
          setSelectedPriority={setSelectedPriority}
          selectedTag={selectedTag}
          setSelectedTag={setSelectedTag}
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          onOpenSettings={() => setIsSettingsModalOpen(true)}
        />

        {/* 2. Main KanBan Board viewport area */}
        <main className="flex-1 flex flex-col h-full overflow-y-auto bg-[#faf7f0] dark:bg-[#1e1914]">
          
          {/* Top Control Navigation bar */}
          <Header
            filteredTasksCount={filteredTasks.length}
            ngrokUrl={ngrokUrl}
            theme={theme}
            setTheme={setTheme}
            setIsSettingsModalOpen={setIsSettingsModalOpen}
            setIsJsonModalOpen={setIsJsonModalOpen}
            setIsSkillsModalOpen={setIsSkillsModalOpen}
            setIsTemplateModalOpen={setIsTemplateModalOpen}
            setIsObservabilityModalOpen={setIsObservabilityModalOpen}
            setIsCreateModalOpen={setIsCreateModalOpen}
            setIsBatchModalOpen={setIsBatchModalOpen}
          />

          {persistenceError && (
            <div className="mx-5 mt-4 rounded-2xl border border-[#f0c48f] dark:border-[#584a3b] bg-[#fff7eb] dark:bg-[#292119] px-4 py-3 text-[11px] font-mono font-bold text-[#9a5b13] dark:text-[#f3eadf]">
              Persistence warning: {persistenceError}
            </div>
          )}

          {/* Kanban Board Container scroll area */}
          <div className="flex-1 overflow-x-auto p-6 bg-[#faf7f0] dark:bg-[#1e1914]">
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
        </main>
      </div>

      {/* Footer Status Bar */}
      <footer className="h-6.5 bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 border-t border-[#ebdcb9] dark:border-[#584a3b] px-4 flex items-center justify-between shrink-0 select-none text-[10px] font-mono text-[#8c7463] dark:text-[#f3eadf] font-bold">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
            <span>Cozy Engine Active</span>
          </div>
          <span className="text-[#ecd0bc] dark:text-[#d6b56d]">•</span>
          <span>Workspace Latency: 2ms</span>
        </div>
        <div className="text-[#8c7463] dark:text-[#f3eadf]">
          Styled cozy & warm
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

      {/* 5. JSON Schema Doc Modal */}
      {isJsonModalOpen && (
        <JsonTemplateModal
          onClose={() => setIsJsonModalOpen(false)}
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
        <SettingsModal
          onClose={() => {
            setIsSettingsModalOpen(false);
            fetchSettingsFromApi();
          }}
        />
      )}

      {/* 9. Emergency Move Modal */}
      {pendingEmergencyMove && (
        <ConfirmModal
          title="Emergency Move"
          message="Task is currently locked in progress. Are you sure you want to force move it?"
          onConfirm={() => {
            executeTaskMove(pendingEmergencyMove.sourceTask, pendingEmergencyMove.status);
            setPendingEmergencyMove(null);
          }}
          onCancel={() => setPendingEmergencyMove(null)}
          confirmText="Force Move"
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


