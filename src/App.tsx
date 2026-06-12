/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  Plus, 
  Terminal, 
  GitPullRequest, 
  Code, 
  ListTodo, 
  Download, 
  Upload, 
  RotateCcw,
  Sparkles,
  GitMerge,
  Cat,
  Moon,
  Coffee,
  FileCode,
  ChevronDown
} from 'lucide-react';
import { Task, TaskStatus, Column, LogEntry, Project } from './types';
import Sidebar from './components/Sidebar';
import TaskCard from './components/TaskCard';
import TaskDetailsDrawer from './components/TaskDetailsDrawer';
import CreateTaskModal from './components/CreateTaskModal';
import JsonTemplateModal from './components/JsonTemplateModal';
import BatchImportModal from './components/BatchImportModal';
import SkillsModal from './components/SkillsModal';
import SettingsModal from './components/SettingsModal';
import NgrokStatusPanel from './components/NgrokStatusPanel';

// Standardized project lanes themed cleanly
const COLUMNS: Column[] = [
  { id: 'backlog', label: 'Backlog Specs 📂', iconName: 'Moon', color: 'border-[#dfd2be]/60 bg-[#fffdfa] text-[#816b5a]' },
  { id: 'todo', label: 'Ready to Do 📌', iconName: 'ListTodo', color: 'border-[#dfd2be]/60 bg-[#fffdfa] text-[#816b5a]' },
  { id: 'in-progress', label: 'In Progress ⚡', iconName: 'Terminal', color: 'border-[#f5cb93] bg-[#fffbf4] text-[#935919]' },
  { id: 'ready-for-review', label: 'Ready for Review 🔍', iconName: 'GitMerge', color: 'border-[#b8cdfc] bg-[#f5f8ff] text-[#3b5eab]' },
  { id: 'done', label: 'Completed ✓', iconName: 'GitPullRequest', color: 'border-[#bddda4] bg-[#edf7ed] text-[#4d7e35]' }
];

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [activeProjectId, setActiveProjectId] = useState<string>(() => {
    return localStorage.getItem('devflow_selected_project') || '';
  });
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedOverColumn, setDraggedOverColumn] = useState<TaskStatus | null>(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isJsonModalOpen, setIsJsonModalOpen] = useState(false);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState(false);
  const [isSkillsModalOpen, setIsSkillsModalOpen] = useState(false);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [mounted, setMounted] = useState(false);
  const [ngrokUrl, setNgrokUrl] = useState('');

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

  // 0. Load projects from REST API (GET /api/projects)
  const fetchProjectsFromApi = async () => {
    try {
      const res = await fetch('/api/projects', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setProjects(data);
        setPersistenceError(null);
        if (data.length > 0) {
          // Check against the current state using functional update to get the latest without dependency
          setActiveProjectId(prev => {
            const isValidId = data.some((p: Project) => p.id === prev);
            return isValidId ? prev : data[0].id;
          });
        }
      }
    } catch (err) {
      console.warn('Backend projects API connection unavailable:', err);
      setPersistenceError('Project data is unavailable because the backend could not be reached. No local fallback was used.');
    }
  };

  // Tasks remain API-backed; we do not silently fall back to localStorage for source-of-truth data.
  const fetchTasksFromApi = async () => {
    try {
      const res = await fetch('/api/tasks', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        setPersistenceError(null);
        setTasks(prev => {
          if (JSON.stringify(prev) === JSON.stringify(data)) return prev;
          return data;
        });
      } else {
        throw new Error('API unstable');
      }
    } catch (err) {
      console.warn('Backend API connection unavailable:', err);
      setPersistenceError('Task data could not be refreshed from the backend. Existing on-screen data was kept unchanged.');
    }
  };

  const handleCreateProject = async (name: string, repoUrl: string, description?: string, localPath?: string, taskIdPrefix?: string) => {
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, repoUrl, description, localPath, taskIdPrefix })
      });
      if (res.ok) {
        const newProj = await res.json();
        setProjects(prev => [...prev, newProj]);
        setActiveProjectId(newProj.id);
        fetchTasksFromApi();
        return true;
      }
    } catch (err) {
      console.error('Failed to create project:', err);
      setPersistenceError('Project creation failed before the backend confirmed persistence.');
    }
    return false;
  };

  const handleDeleteProject = async (id: string) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'DELETE'
      });
      if (res.ok) {
        let remainingProjects: Project[] = [];
        setProjects(prev => {
          remainingProjects = prev.filter(p => p.id !== id);
          return remainingProjects;
        });
        
        setActiveProjectId(prevId => {
          if (prevId === id) {
            return remainingProjects.length > 0 ? remainingProjects[0].id : '';
          }
          return prevId;
        });
        
        fetchTasksFromApi();
        return true;
      }
    } catch (err) {
      console.error('Failed to delete project:', err);
      setPersistenceError('Project deletion failed before the backend confirmed persistence.');
    }
    return false;
  };

  const handleUpdateProject = async (id: string, updates: Partial<Project>) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
      });
      if (res.ok) {
        const updatedProj = await res.json();
        setProjects(prev => prev.map(p => p.id === id ? updatedProj : p));
        return true;
      }
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
    fetchTasksFromApi();

    // Auto-polling every 5 seconds
    const intervalId = setInterval(() => {
      fetchTasksFromApi();
    }, 5000);

    return () => clearInterval(intervalId);
  }, []);

  // Keep UI-only preference in localStorage; task data remains backend-owned.
  useEffect(() => {
    if (mounted && activeProjectId) {
      localStorage.setItem('devflow_selected_project', activeProjectId);
    }
  }, [activeProjectId, mounted]);

  // Handle Drag Start
  const handleDragStart = (e: React.DragEvent, id: string) => {
    setDraggedTaskId(id);
    e.dataTransfer.setData('text/plain', id);
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

    if (sourceTask.status === 'in-progress') {
      const lockOverride = window.prompt("Task is locked. Type 'Emergency Move' to force it:");
      if (lockOverride !== 'Emergency Move') {
        setDraggedTaskId(null);
        setDraggedOverColumn(null);
        return;
      }
    }

    const modifiedLogs: LogEntry[] = [
      ...sourceTask.logs,
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
      const payload = isEmergency ? { ...updatedTask, emergency: true } : updatedTask;
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(`Lane move failed with status ${response.status}`);
      }
      setPersistenceError(null);
    } catch (err) {
      console.error('API lane move sync failed:', err);
      setPersistenceError('Lane move was shown optimistically, but backend persistence failed. Refresh after backend recovery to confirm final state.');
    }
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
        await fetchTasksFromApi();
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

  const handleDeleteTask = async (id: string) => {
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



  // Helper column icon matching
  const getColIcon = (iconName: string) => {
    switch (iconName) {
      case 'Moon': return <Moon size={15} />;
      case 'ListTodo': return <ListTodo size={15} />;
      case 'Terminal': return <Terminal size={15} />;
      case 'GitMerge': return <GitMerge size={15} />;
      case 'GitPullRequest': return <GitPullRequest size={15} />;
      default: return <Cat size={15} />;
    }
  };

  // Filter Tasks
  const filteredTasks = tasks.filter(task => {
    // Only show tasks of the current active project
    if (task.projectId !== activeProjectId) return false;

    const matchesPriority = selectedPriority === 'all' || task.priority === selectedPriority;
    const matchesTag = selectedTag === 'all' || task.tags.includes(selectedTag);
    const query = searchQuery.trim().toLowerCase();
    const matchesSearch = !query || 
      task.title.toLowerCase().includes(query) || 
      task.id.toLowerCase().includes(query) ||
      (task.branch && task.branch.toLowerCase().includes(query));

    // Support bubble-up searching: if a child task matches, show the parent task on the board
    let subtaskMatches = false;
    if (!task.parentId) {
      const childTasks = tasks.filter(t => t.parentId === task.id && t.projectId === activeProjectId);
      subtaskMatches = childTasks.some(ct => {
        const ctMatchesPriority = selectedPriority === 'all' || ct.priority === selectedPriority;
        const ctMatchesTag = selectedTag === 'all' || ct.tags.includes(selectedTag);
        const ctMatchesSearch = !query || 
          ct.title.toLowerCase().includes(query) || 
          ct.id.toLowerCase().includes(query) ||
          (ct.branch && ct.branch.toLowerCase().includes(query));
        return ctMatchesPriority && ctMatchesTag && ctMatchesSearch;
      });
    }

    return (matchesPriority && matchesTag && matchesSearch) || subtaskMatches;
  });

  if (!mounted) {
    return (
      <div className="min-h-screen bg-[#faf6ef] flex flex-col items-center justify-center text-[#8a6e5a] font-mono text-xs gap-3">
        <Cat size={40} className="text-[#d89745] animate-bounce" />
        <p>Waking up sleepy kittens... ฅ^•ﻌ•^ฅ</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-[#fcfaf4] text-[#3e3129] font-sans antialiased overflow-hidden select-none">
      
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
        <main className="flex-1 flex flex-col h-full overflow-y-auto bg-[#faf7f0]">
          
          {/* Top Control Navigation bar */}
          <header className="p-5 bg-white border-b border-[#e5d4bb] flex flex-col md:flex-row gap-4 justify-between items-start md:items-center">
            <div>
              <h1 className="text-[#3c2a1a] font-extrabold font-sans text-base tracking-tight flex items-center gap-2">
                <Cat className="text-[#d89745] shrink-0" size={17} />
                Sprint Backlog Dashboard
              </h1>
              <p className="text-[11px] text-[#816b5a] font-mono mt-0.5 flex items-center gap-1 font-bold">
                <span>Pocket Sandbox Launcher</span>
                <span className="text-[#dcd0bc]">•</span>
                <span className="text-[#d89745] font-extrabold">{filteredTasks.length} lazy tasks found</span>
              </p>
            </div>

            {/* DevOps backup and Reset buttons */}
            <div className="flex flex-wrap items-center justify-end gap-3 w-full md:w-auto">
              
              {/* Ngrok Status */}
              <NgrokStatusPanel 
                ngrokUrl={ngrokUrl} 
                onOpenSettings={() => setIsSettingsModalOpen(true)} 
              />
              
              {/* Backup actions */}
              <div className="flex items-center gap-1.5 bg-[#fdfbf6] border border-[#e5d4bb] rounded-xl p-1 shadow-2xs">
                <button
                  onClick={() => setIsJsonModalOpen(true)}
                  type="button"
                  className="hover:bg-[#ebdcb9] hover:text-[#534135] px-2.5 py-1 text-[10px] font-mono rounded-lg flex items-center gap-1 transition-colors cursor-pointer text-[#a46c24] font-bold"
                  title="View import JSON schema format"
                >
                  <FileCode size={11} /> Schema Spec
                </button>
                <div className="w-px h-4 bg-[#ebdcb9]"></div>
                <button
                  onClick={() => setIsSkillsModalOpen(true)}
                  type="button"
                  className="hover:bg-[#ebdcb9] hover:text-[#534135] px-2.5 py-1 text-[10px] font-mono rounded-lg flex items-center gap-1 transition-colors cursor-pointer text-[#a46c24] font-bold"
                  title="View and Edit Agent Skills"
                >
                  <Code size={11} /> Skills
                </button>
              </div>

              {/* Combined Ticket Action Menu */}
              <div className="relative">
                <button
                  onClick={() => setIsActionMenuOpen(!isActionMenuOpen)}
                  type="button"
                  className="bg-gradient-to-r from-[#df9433] to-[#cc7b26] hover:from-[#cc7b26] hover:to-[#b5671d] text-white px-4 py-1.5 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition-all shadow-md cursor-pointer ml-auto md:ml-0"
                >
                  <Plus size={14} /> ✨ Ticket Action <ChevronDown size={14} />
                </button>
                {isActionMenuOpen && (
                  <div className="absolute top-full right-0 mt-2 bg-white rounded-xl shadow-xl border border-[#ebdcb9] py-1 min-w-[200px] z-50 flex flex-col">
                    <button
                      onClick={() => {
                        setIsActionMenuOpen(false);
                        setIsCreateModalOpen(true);
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-[#ebdcb9]/40 text-xs font-bold text-[#df9433] flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <Sparkles size={14} /> Commit Ticket
                    </button>
                    <div className="h-px bg-[#ebdcb9]/40 w-full" />
                    <button
                      onClick={() => {
                        setIsActionMenuOpen(false);
                        setIsBatchModalOpen(true);
                      }}
                      className="w-full text-left px-4 py-2.5 hover:bg-[#ebdcb9]/40 text-xs font-bold text-[#2a7a8a] flex items-center gap-2 transition-colors cursor-pointer"
                    >
                      <Plus size={14} /> Batch Import JSON
                    </button>
                  </div>
                )}
              </div>
            </div>
          </header>

          {persistenceError && (
            <div className="mx-5 mt-4 rounded-2xl border border-[#f0c48f] bg-[#fff7eb] px-4 py-3 text-[11px] font-mono font-bold text-[#9a5b13]">
              Persistence warning: {persistenceError}
            </div>
          )}

          {/* Kanban Board Container scroll area */}
          <div className="flex-1 overflow-x-auto p-6 bg-[#faf7f0]">
            <div className="flex gap-4 w-max items-stretch min-h-[calc(100vh-210px)] pb-2">
              
              {COLUMNS.map(col => {
                const columnTasks = filteredTasks
                  .filter(t => t.status === col.id && !t.parentId)
                  .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
                const totalStepsInLane = columnTasks.reduce((sum, t) => sum + (t.checklist?.length || 0), 0);
                const completedStepsInLane = columnTasks.reduce((sum, t) => sum + (t.checklist?.filter(item => item.completed).length || 0), 0);
                const isOver = draggedOverColumn === col.id;
                const isInProgressCol = col.id === 'in-progress';
                const isReviewCol = col.id === 'ready-for-review';
                const isDoneCol = col.id === 'done';
 
                return (
                  <div
                    key={col.id}
                    onDragOver={(e) => {
                      e.preventDefault();
                      if (draggedOverColumn !== col.id) {
                        setDraggedOverColumn(col.id);
                      }
                    }}
                    onDragLeave={() => {
                      if (draggedOverColumn === col.id) {
                        setDraggedOverColumn(null);
                      }
                    }}
                    onDrop={(e) => handleDrop(e, col.id)}
                    className={`w-[290px] shrink-0 flex flex-col pb-4 rounded-2xl p-2 transition-all border ${
                      isOver 
                        ? 'bg-[#ffeccb]/40 border-dashed border-[#e3a35a]' 
                        : isInProgressCol
                          ? 'bg-[#fffcf7] border-[#ebdcb9]'
                          : isReviewCol
                            ? 'bg-[#f5f8ff] border-[#b8cdfc]'
                            : isDoneCol
                              ? 'bg-[#f4faf4] border-[#d1e9cc]'
                              : 'bg-[#fffdfb]/60 border-[#ebdcb9]/40'
                    }`}
                  >
                    {/* Status header lane metadata */}
                    <div className="flex items-center justify-between mb-3.5 px-2.5 pt-1.5 select-none">
                      <div className="flex items-center gap-2">
                        <span className={`shrink-0 ${
                          isInProgressCol 
                            ? 'text-[#d89745]' 
                            : isReviewCol 
                              ? 'text-[#3b5eab]' 
                              : isDoneCol 
                                ? 'text-[#5fa84a]' 
                                : 'text-[#8a725f]'
                        }`}>{getColIcon(col.iconName)}</span>
                        
                        <h3 className={`text-[11px] font-extrabold uppercase tracking-wide font-mono ${
                          isInProgressCol 
                            ? 'text-[#8f5e1f]' 
                            : isReviewCol 
                              ? 'text-[#2b3a61]' 
                              : isDoneCol 
                                ? 'text-[#38622c]' 
                                : 'text-[#614e41]'
                        }`}>
                          {col.label}
                        </h3>
                        
                        <span className={`text-[10px] font-mono px-2 py-0.5 rounded-full font-bold shadow-4xs ${
                          isInProgressCol 
                            ? 'bg-[#ffecca] text-[#935919]' 
                            : isReviewCol 
                              ? 'bg-[#dbe4ff] text-[#2b4c9e]' 
                              : isDoneCol 
                                ? 'bg-[#edf7ed] text-[#4d7e35]' 
                                : 'bg-[#f4ebd9] text-[#715c4d]'
                        }`}>
                          {columnTasks.length}
                        </span>
                      </div>

                      {totalStepsInLane > 0 && (
                        <span className="text-[9px] font-mono text-[#8a705e] uppercase tracking-wider font-extrabold" title="Verification checklist completion ratio">
                          {completedStepsInLane}/{totalStepsInLane} steps
                        </span>
                      )}
                    </div>

                    {/* Vertically scrolling task card stack with HTML5 drop border feedback */}
                    <div 
                      className="flex-1 flex flex-col gap-3 p-2 rounded-xl overflow-y-auto scrollbar-thin transition-all"
                    >
                      {columnTasks.map(task => {
                        const subtasks = tasks.filter(t => t.parentId === task.id);
                        return (
                          <TaskCard
                            key={task.id}
                            task={task}
                            subtasks={subtasks}
                            onSelect={setSelectedTask}
                            onDelete={handleDeleteTask}
                            onDragStart={handleDragStart}
                            onUpdate={handleUpdateTask}
                          />
                        );
                      })}

                      {columnTasks.length === 0 && (
                        <div className="flex-1 flex flex-col items-center justify-start py-8 px-4 bg-transparent select-none">
                          <div className="w-full max-w-[210px] bg-white/60 border border-[#e2d5c3]/60 rounded-2xl p-3.5 text-center shadow-xs">
                            <span className="text-[10px] text-[#df9433] font-extrabold uppercase tracking-widest flex items-center justify-center gap-1">
                              ✨ EMPTY LANE
                            </span>
                            <p className="text-[9px] text-[#8c7463] font-mono mt-1 leading-snug">
                              No active tickets. Drop cards or Commit to start.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </main>
      </div>

      {/* Footer Status Bar */}
      <footer className="h-6.5 bg-[#ebdcb9]/40 border-t border-[#ebdcb9] px-4 flex items-center justify-between shrink-0 select-none text-[10px] font-mono text-[#8c7463] font-bold">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-orange-500 animate-pulse"></span>
            <span>Cozy Engine Active</span>
          </div>
          <span className="text-[#ecd0bc]">•</span>
          <span>Workspace Latency: 2ms</span>
        </div>
        <div className="text-[#8c7463]">
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

      {/* 7. Settings Modal */}
      {isSettingsModalOpen && (
        <SettingsModal
          onClose={() => {
            setIsSettingsModalOpen(false);
            fetchSettingsFromApi();
          }}
        />
      )}
    </div>
  );
}
