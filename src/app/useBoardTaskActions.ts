import { useState, type Dispatch, type DragEvent, type SetStateAction } from 'react';
import type { Project, Task, TaskStatus, LogEntry } from '../types';
import { isValidTransition, getValidationErrorMessage } from '../lib/statusTransitions';
import { buildTaskStatusMoveRequest } from '../lib/taskStatusMove';
import type { TaskMoveDecision } from '../components/TaskMoveBlockerDialog';

interface BoardTaskActionsOptions {
  projects: Project[];
  activeProjectId: string | null;
  tasks: Task[];
  setTasks: (update: (previous: Task[]) => Task[]) => void;
  selectedTask: Task | null;
  setSelectedTask: Dispatch<SetStateAction<Task | null>>;
  setPersistenceError: Dispatch<SetStateAction<string | null>>;
  setIsCreateModalOpen: Dispatch<SetStateAction<boolean>>;
  setIsBatchModalOpen: Dispatch<SetStateAction<boolean>>;
  refreshBoard: () => Promise<unknown> | unknown;
  setTaskPending: (taskId: string, pending: boolean) => void;
}

export function useBoardTaskActions({
  projects,
  activeProjectId,
  tasks,
  setTasks,
  selectedTask,
  setSelectedTask,
  setPersistenceError,
  setIsCreateModalOpen,
  setIsBatchModalOpen,
  refreshBoard,
  setTaskPending,
}: BoardTaskActionsOptions) {
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedOverColumn, setDraggedOverColumn] = useState<TaskStatus | null>(null);
  const [pendingMoveDecision, setPendingMoveDecision] = useState<{
    sourceTask: Task;
    status: TaskStatus;
    decision: TaskMoveDecision;
  } | null>(null);
  const [taskToDelete, setTaskToDelete] = useState<string | null>(null);

  const handleDragStart = (event: DragEvent, id: string) => {
    setDraggedTaskId(id);
    event.dataTransfer.setData('text/plain', id);
  };

  const executeTaskMove = async (sourceTask: Task, status: TaskStatus, manualOverride = false) => {
    const taskId = sourceTask.id;
    const modifiedLogs: LogEntry[] = [
      ...(sourceTask.logs || []),
      {
        id: `log-move-${Date.now()}`,
        timestamp: new Date().toISOString(),
        message: `Moved card from ${sourceTask.status.toUpperCase()} to ${status.toUpperCase()} lane`,
        type: 'move',
      },
    ];
    const updatedTask: Task = {
      ...sourceTask,
      status,
      logs: modifiedLogs,
      updatedAt: new Date().toISOString(),
    };

    setTaskPending(taskId, true);
    setTasks((previous) => previous.map((task) => task.id === taskId ? updatedTask : task));
    if (selectedTask?.id === taskId) setSelectedTask(updatedTask);
    setDraggedTaskId(null);
    setDraggedOverColumn(null);

    try {
      const moveRequest = buildTaskStatusMoveRequest(taskId, status, { intent: 'manual', manualOverride });
      const response = await fetch(moveRequest.url, moveRequest.init);
      const responseData = await response.json().catch(() => ({}));
      if (!response.ok) {
        setTasks((previous) => previous.map((task) => task.id === taskId ? sourceTask : task));
        if (selectedTask?.id === taskId) setSelectedTask(sourceTask);
        const blockers = Array.isArray(responseData.blockers) ? responseData.blockers : [];
        if (blockers.length > 0) {
          setPendingMoveDecision({ sourceTask, status, decision: { ...responseData, blockers } });
          setPersistenceError(null);
          return;
        }
        setPersistenceError(responseData.message || responseData.error || `Lane move failed with status ${response.status}`);
        return;
      }
      const persistedTask = responseData.task || responseData;
      setTasks((previous) => previous.map((task) => task.id === taskId ? persistedTask : task));
      if (selectedTask?.id === taskId) setSelectedTask(persistedTask);
      setPersistenceError(null);
    } catch (error) {
      console.error('API lane move sync failed:', error);
      setTasks((previous) => previous.map((task) => task.id === taskId ? sourceTask : task));
      if (selectedTask?.id === taskId) setSelectedTask(sourceTask);
      setPersistenceError('Lane move could not reach the backend. The card was restored to its previous lane.');
    } finally {
      setTaskPending(taskId, false);
    }
  };

  const handleDrop = async (event: DragEvent, status: TaskStatus) => {
    event.preventDefault();
    const taskId = draggedTaskId || event.dataTransfer.getData('text/plain');
    if (!taskId) return;
    const sourceTask = tasks.find((task) => task.id === taskId);
    if (!sourceTask) return;
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

  const createTask = async (newTaskProps: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => {
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const repoUrl = activeProject ? activeProject.repoUrl : 'https://github.com/google/ai-studio';
    const taskWithProject = { ...newTaskProps, projectId: activeProjectId, repo: repoUrl };
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(taskWithProject),
      });
      if (response.ok) {
        const createdTask = await response.json();
        setTasks((previous) => [createdTask, ...previous]);
        setIsCreateModalOpen(false);
        setPersistenceError(null);
        return;
      }
      throw new Error(`Task creation failed with status ${response.status}`);
    } catch (error) {
      console.error('API creation failed:', error);
      setPersistenceError('Task creation failed before the backend confirmed persistence. No local fallback task was created.');
    }
  };

  const batchImport = async (parsedJson: any): Promise<boolean> => {
    let rawItems = parsedJson;
    let outerRepo: string | undefined;
    if (rawItems && typeof rawItems === 'object' && !Array.isArray(rawItems) && Array.isArray(rawItems.tasks)) {
      outerRepo = rawItems.repo || rawItems.repoUrl;
      rawItems = rawItems.tasks.map((taskItem: any) => {
        if (typeof taskItem === 'object' && taskItem !== null && !taskItem.repo && !taskItem.repoUrl && outerRepo) {
          return { ...taskItem, repo: outerRepo };
        }
        return taskItem;
      });
    }
    const finalArray = Array.isArray(rawItems) ? rawItems : [rawItems];
    const activeProject = projects.find((project) => project.id === activeProjectId);
    const defaultRepo = activeProject ? activeProject.repoUrl : 'https://github.com/google/ai-studio';
    const itemsWithProject = finalArray.map((item: any) => ({
      ...item,
      projectId: item.projectId || activeProjectId,
      repo: item.repo || item.repoUrl || defaultRepo,
    }));
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(itemsWithProject),
      });
      if (response.ok) {
        await refreshBoard();
        setIsBatchModalOpen(false);
        setPersistenceError(null);
        return true;
      }
      throw new Error(`Batch import failed with status ${response.status}`);
    } catch (error) {
      console.error('API batch creation failed:', error);
      setPersistenceError('Batch import failed before the backend confirmed persistence. No offline import fallback was applied.');
      return false;
    }
  };

  const updateTask = async (updatedTask: Task) => {
    setTasks((previous) => previous.map((task) => task.id === updatedTask.id ? updatedTask : task));
    if (selectedTask?.id === updatedTask.id) setSelectedTask(updatedTask);
    const taskProject = projects.find((project) => project.id === updatedTask.projectId);
    try {
      const response = await fetch(`/api/tasks/${updatedTask.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...updatedTask, repo: taskProject ? taskProject.repoUrl : undefined }),
      });
      if (!response.ok) throw new Error(`Task update failed with status ${response.status}`);
      setPersistenceError(null);
    } catch (error) {
      console.error('API modification update failed:', error);
      setPersistenceError('Task update failed before the backend confirmed persistence.');
    }
  };

  const deleteTask = async (id: string) => {
    setTasks((previous) => previous.filter((task) => task.id !== id));
    if (selectedTask?.id === id) setSelectedTask(null);
    try {
      const response = await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
      if (!response.ok) throw new Error(`Task deletion failed with status ${response.status}`);
      setPersistenceError(null);
    } catch (error) {
      console.error('API deletion sync failed:', error);
      setPersistenceError('Task deletion failed before the backend confirmed persistence.');
    }
  };

  return {
    draggedTaskId,
    draggedOverColumn,
    setDraggedOverColumn,
    pendingMoveDecision,
    setPendingMoveDecision,
    taskToDelete,
    setTaskToDelete,
    handleDragStart,
    executeTaskMove,
    handleDrop,
    createTask,
    batchImport,
    updateTask,
    deleteTask,
  };
}
