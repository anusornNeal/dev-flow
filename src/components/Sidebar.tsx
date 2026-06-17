/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  Heart, 
  Filter, 
  Hash, 
  FolderGit, 
  TrendingUp, 
  Flame, 
  Sparkles,
  Coffee,
  Smile,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Trash2,
  Plus,
  ExternalLink,
  Settings
} from 'lucide-react';
import { Task, TaskPriority, Project } from '../types';

interface SidebarProps {
  tasks: Task[];
  projects: Project[];
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  onCreateProject: (name: string, repoUrl: string, description?: string, localPath?: string, taskIdPrefix?: string) => Promise<boolean>;
  onDeleteProject: (id: string) => Promise<boolean>;
  onUpdateProject: (id: string, updates: Partial<Project>) => Promise<boolean>;
  selectedPriority: TaskPriority | 'all';
  setSelectedPriority: (priority: TaskPriority | 'all') => void;
  selectedTag: string | 'all';
  setSelectedTag: (tag: string | 'all') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  onOpenSettings: () => void;
}

export default function Sidebar({
  tasks,
  projects,
  activeProjectId,
  setActiveProjectId,
  onCreateProject,
  onDeleteProject,
  onUpdateProject,
  selectedPriority,
  setSelectedPriority,
  selectedTag,
  setSelectedTag,
  searchQuery,
  setSearchQuery,
  onOpenSettings
}: SidebarProps) {
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const [cozySpeak, setCozySpeak] = useState('☕ Fuel configured! Time to inspect some specifications.');
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectRepoUrl, setNewProjectRepoUrl] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  const [newProjectLocalPath, setNewProjectLocalPath] = useState('');
  const [newProjectTaskIdPrefix, setNewProjectTaskIdPrefix] = useState('');

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsProjectDropdownOpen(false);
      }
    }
    
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setIsProjectDropdownOpen(false);
      }
    }

    if (isProjectDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isProjectDropdownOpen]);
  
  // Compute Stats
  const mainTasks = tasks.filter(t => !t.parentId);
  const totalTasks = mainTasks.length;
  const activeBranches = mainTasks.filter(t => t.branch && t.status !== 'done').map(t => t.branch);
  const completedTasks = mainTasks.filter(t => t.status === 'done').length;

  // Get unique tags
  const tagsMap = new Map<string, number>();
  mainTasks.forEach(t => {
    t.tags.forEach(tag => {
      tagsMap.set(tag, (tagsMap.get(tag) || 0) + 1);
    });
  });
  const allTags = Array.from(tagsMap.entries()).sort((a, b) => b[1] - a[1]);

  // Priority count helper
  const highPriorityCount = mainTasks.filter(t => t.priority === 'high').length;
  const mediumPriorityCount = mainTasks.filter(t => t.priority === 'medium').length;
  const lowPriorityCount = mainTasks.filter(t => t.priority === 'low').length;

  // Enjoy coffee interaction
  const handleEnjoyCoffee = (e: React.MouseEvent<HTMLButtonElement>) => {
    const speakOptions = [
      '☕ Mmm, hot espresso brewed. Ready to commit!',
      '🍂 Rainy day vibes, warm console prompt active.',
      '✨ Simple structures, robust implementations.',
      '🍵 Chamomile tea for high severity debugging.',
      '🌾 A clean workspace, a happy developer flow.',
      '💫 "Make it work, make it right, make it fast."'
    ];
    setCozySpeak(speakOptions[Math.floor(Math.random() * speakOptions.length)]);

    // Spawn floating love hearts
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const newHeart = { id: Date.now(), x, y };
    
    setHearts(prev => [...prev, newHeart]);
    setTimeout(() => {
      setHearts(prev => prev.filter(h => h.id !== newHeart.id));
    }, 1000);
  };

  return (
    <aside className="w-full lg:w-72 bg-[#f4ebd9] dark:bg-[#292119] border-b lg:border-b-0 lg:border-r border-[#e5d4bb] dark:border-[#584a3b] flex flex-col h-full shrink-0 select-none">
      
      {/* Cozy Warm Mascot Header */}
      <div className="p-6 border-b border-[#e5d4bb] dark:border-[#584a3b] bg-[#ede0c9] dark:bg-[#292119]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={handleEnjoyCoffee}
              type="button"
              className="relative bg-[#ffb766] dark:bg-[#e0a070] hover:bg-[#ffa23b] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] p-3 rounded-full border border-[#e5a043] dark:border-[#584a3b] shadow-sm transition-all active:scale-90 group cursor-pointer animate-pulse"
              title="Click to take a sip of espresso!"
            >
              <Coffee size={24} className="text-[#553108] dark:text-[#f3eadf] group-hover:scale-110 transition-transform" />
              {/* Hearts float effect */}
              {hearts.map(h => (
                <span
                  key={h.id}
                  className="absolute text-orange-600 animate-float-heart pointer-events-none"
                  style={{ left: h.x, top: h.y }}
                >
                  <Heart size={14} fill="currentColor" />
                </span>
              ))}
            </button>
            <div>
              <h2 className="text-xs font-extrabold text-[#534135] dark:text-[#f3eadf] tracking-wide flex items-center gap-1.5 leading-none">
                ✨ CozyFlow
              </h2>
              <span className="text-[10px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mt-1">
                Minimalist Spec Space
              </span>
            </div>
          </div>

          {/* Dialog Bubble */}
          <div className="bg-[#fffdfb] dark:bg-[#292119] px-3.5 py-2.5 rounded-2xl relative border border-[#e5d4bb] dark:border-[#584a3b] shadow-xs text-[11px] text-[#55453B] dark:text-[#f3eadf] font-mono leading-relaxed">
            <span className="absolute left-5 -top-2 w-3 h-3 bg-[#fffdfb] dark:bg-[#292119] border-t border-l border-[#e5d4bb] dark:border-[#584a3b] rotate-45" />
            <p className="relative z-10">{cozySpeak}</p>
          </div>
        </div>
      </div>

      {/* Current Board Indicator / Interactive Project Selector */}
      <div className="relative mx-4 my-3">
        {/* Toggleable Panel Card */}
        <button
          onClick={() => {
            setIsProjectDropdownOpen(!isProjectDropdownOpen);
            setIsAddingProject(false); // Reset add mode when toggling
            setEditingProjectId(null);
          }}
          type="button"
          className="w-full text-left p-4 bg-[#fdfaf5] dark:bg-[#292119] hover:bg-[#fffdf8] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] flex items-center justify-between gap-2.5 shadow-xs cursor-pointer transition-all active:scale-[0.99]"
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Sparkles size={15} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-extrabold text-[#534135] dark:text-[#f3eadf] truncate" title={projects.find(p => p.id === activeProjectId)?.name}>
                {projects.find(p => p.id === activeProjectId)?.name || 'Developer Sandbox Repo'}
              </p>
              {projects.find(p => p.id === activeProjectId)?.repoUrl && (
                <p className="text-[9px] text-[#8c7463] dark:text-[#d6b56d] font-sans truncate max-w-full opacity-90 mt-0.5" title={projects.find(p => p.id === activeProjectId)?.repoUrl}>
                  {projects.find(p => p.id === activeProjectId)?.repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '')}
                </p>
              )}
              {(projects.find(p => p.id === activeProjectId)?.localPath || projects.find(p => p.id === activeProjectId)?.taskIdPrefix) && (
                <div className="flex items-center gap-2 mt-1 text-[8px] text-[#9b8271] dark:text-[#d6b56d] font-mono opacity-80">
                  {projects.find(p => p.id === activeProjectId)?.localPath && (
                    <span className="truncate max-w-[140px]" title={projects.find(p => p.id === activeProjectId)?.localPath}>
                      📂 {projects.find(p => p.id === activeProjectId)?.localPath}
                    </span>
                  )}
                  {projects.find(p => p.id === activeProjectId)?.taskIdPrefix && (
                    <span className="shrink-0 bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 px-1 rounded">
                      🏷️ {projects.find(p => p.id === activeProjectId)?.taskIdPrefix}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
          {isProjectDropdownOpen ? (
            <ChevronUp size={14} className="text-[#8c7463] dark:text-[#f3eadf]" />
          ) : (
            <ChevronDown size={14} className="text-[#8c7463] dark:text-[#f3eadf]" />
          )}
        </button>

        {isProjectDropdownOpen && (
          <div ref={dropdownRef} className="absolute top-[calc(100%+8px)] left-0 w-80 z-50 bg-[#fffefd] dark:bg-[#292119] border border-[#d8c5aa] dark:border-[#584a3b] rounded-xl shadow-xl p-4 space-y-3 text-xs font-sans">
            {!isAddingProject ? (
              <>
                <p className="text-[10px] text-[#8C7565] dark:text-[#f3eadf] font-bold uppercase tracking-widest border-b border-[#f1e6d4] dark:border-[#584a3b] pb-2 mb-2">
                  Active Workspace & Repositories
                </p>
                <div className="space-y-2.5 max-h-72 overflow-y-auto scrollbar-thin pr-1">
                  {projects.map((project) => {
                    const isActive = project.id === activeProjectId;
                    const isEditing = editingProjectId === project.id;
                    
                    if (isEditing) {
                      return (
                        <div key={project.id} className="p-3 rounded-lg border border-[#d89745] dark:border-[#e0a070] bg-[#fff9ee] dark:bg-[#292119] mb-1" onClick={(e) => e.stopPropagation()}>
                          <div className="space-y-2">
                            <input
                              type="text"
                              value={newProjectLocalPath}
                              onChange={(e) => setNewProjectLocalPath(e.target.value)}
                              placeholder="Local absolute path"
                              className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1.5 rounded-md text-[10px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono"
                            />
                            <input
                              type="text"
                              value={newProjectTaskIdPrefix}
                              onChange={(e) => setNewProjectTaskIdPrefix(e.target.value)}
                              placeholder="Task ID Prefix (e.g. DVF)"
                              className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1.5 rounded-md text-[10px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono"
                            />
                            <div className="flex gap-2 mt-1">
                              <button
                                onClick={() => setEditingProjectId(null)}
                                className="flex-1 text-[10px] font-bold border border-[#ebdcb9] dark:border-[#584a3b] py-1.5 rounded hover:bg-white dark:hover:bg-[#292119] text-[#7a6455] dark:text-[#f3eadf] transition-colors"
                              >Cancel</button>
                              <button
                                onClick={async () => {
                                  const success = await onUpdateProject(project.id, { 
                                    localPath: newProjectLocalPath,
                                    taskIdPrefix: newProjectTaskIdPrefix || undefined
                                  });
                                  if (success) setEditingProjectId(null);
                                }}
                                className="flex-1 text-[10px] bg-[#d89745] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] py-1.5 rounded font-bold hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] transition-colors"
                              >Save</button>
                            </div>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div
                        key={project.id}
                        onClick={() => {
                          setActiveProjectId(project.id);
                          setIsProjectDropdownOpen(false);
                        }}
                        className={`p-3 rounded-lg border flex flex-col gap-2 cursor-pointer transition-all ${
                          isActive
                            ? 'bg-[#ffeecd] dark:bg-[#292119] border-[#e4be93] dark:border-[#584a3b] text-[#69441a] dark:text-[#f3eadf] shadow-sm'
                            : 'bg-white dark:bg-[#292119] hover:bg-[#fff9ee] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#55453B] dark:text-[#f3eadf]'
                        }`}
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-extrabold text-[12px] truncate flex items-center gap-1.5 text-[#534135] dark:text-[#f3eadf]">
                              {isActive && <Sparkles size={12} className="text-[#d89745] dark:text-[#e0a070]" />} {project.name}
                            </p>
                            <p className="text-[10px] text-[#917d71] dark:text-[#d6b56d] font-mono truncate mt-0.5" title={project.repoUrl}>
                              {project.repoUrl.replace(/^https?:\/\/(www\.)?/, '')}
                            </p>
                          </div>
                        </div>
                        
                        {(project.localPath || project.taskIdPrefix) && (
                          <div className="flex flex-wrap gap-2 text-[9px] text-[#b39e90] dark:text-[#d6b56d] font-mono bg-[#fcfaf4] dark:bg-[#1e1914] p-1.5 rounded border border-[#ebdcb9]/50 dark:border-[#584a3b]/50">
                            {project.localPath && (
                              <p className="truncate flex-1 min-w-[100px]" title={project.localPath}>
                                📂 {project.localPath}
                              </p>
                            )}
                            {project.taskIdPrefix && (
                              <p className="shrink-0 bg-[#ebdcb9]/30 dark:bg-[#584a3b]/30 px-1 rounded text-[#8c7463] dark:text-[#f3eadf]">
                                🏷️ {project.taskIdPrefix}
                              </p>
                            )}
                          </div>
                        )}
                        
                        {/* Action Buttons Row */}
                        <div className="flex items-center gap-2 mt-1 pt-2 border-t border-[#ebdcb9]/50 dark:border-[#584a3b]/50" onClick={(e) => e.stopPropagation()}>
                          <a
                            href={project.repoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex-1 flex items-center justify-center gap-1.5 p-1.5 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded text-[#7a6455] dark:text-[#f3eadf] hover:bg-[#fff9ef] hover:text-[#d89745] transition-colors text-[9px] font-bold"
                            title="Open repository in new tab"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <ExternalLink size={10} /> Open
                          </a>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setNewProjectLocalPath(project.localPath || '');
                              setNewProjectTaskIdPrefix(project.taskIdPrefix || '');
                              setEditingProjectId(project.id);
                            }}
                            type="button"
                            className="flex-1 flex items-center justify-center gap-1.5 p-1.5 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded text-[#7a6455] dark:text-[#f3eadf] hover:bg-[#fff9ef] hover:text-[#d89745] transition-colors cursor-pointer text-[9px] font-bold"
                            title="Edit project settings"
                          >
                            <Settings size={10} /> Settings
                          </button>
                          
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (confirm(`Are you sure you want to delete project "${project.name}" and all its tasks?`)) {
                                onDeleteProject(project.id);
                              }
                            }}
                            type="button"
                            className="flex-1 flex items-center justify-center gap-1.5 p-1.5 bg-[#fff5f5] dark:bg-[#3d2323] border border-[#ffcdcd] dark:border-[#5c3535] rounded text-[#d64545] hover:bg-[#ffebeb] hover:text-[#e02424] transition-colors cursor-pointer text-[9px] font-bold"
                            title="Delete project"
                          >
                            <Trash2 size={10} /> Delete
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => setIsAddingProject(true)}
                  type="button"
                  className="w-full mt-3 bg-[#d89745] dark:bg-[#e0a070] hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] py-2.5 rounded-lg text-[11px] font-extrabold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow-sm"
                >
                  <Plus size={14} /> Bind New Repository
                </button>
              </>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  if (!newProjectName.trim() || !newProjectRepoUrl.trim()) return;
                  const success = await onCreateProject(
                    newProjectName.trim(),
                    newProjectRepoUrl.trim(),
                    newProjectDesc.trim(),
                    newProjectLocalPath.trim(),
                    newProjectTaskIdPrefix.trim() || undefined
                  );
                  if (success) {
                    setNewProjectName('');
                    setNewProjectRepoUrl('');
                    setNewProjectDesc('');
                    setNewProjectLocalPath('');
                    setNewProjectTaskIdPrefix('');
                    setIsAddingProject(false);
                  }
                }}
                className="space-y-3 mt-1"
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-[10px] text-[#8C7565] dark:text-[#f3eadf] font-bold uppercase tracking-widest border-b border-[#f1e6d4] dark:border-[#584a3b] pb-2">
                  <Plus size={12} className="inline mr-1" /> Bind New Repository
                </p>
                <div className="space-y-2.5 text-[11px]">
                  <div>
                    <span className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mb-1">Project Name</span>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Android Customer App"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-3 py-1.5 rounded-md text-[11px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mb-1">Git Repo URL (HTTPS)</span>
                    <input
                      type="url"
                      required
                      placeholder="https://github.com/user/repo"
                      value={newProjectRepoUrl}
                      onChange={(e) => setNewProjectRepoUrl(e.target.value)}
                      className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-3 py-1.5 rounded-md text-[11px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mb-1">Description (Optional)</span>
                    <input
                      type="text"
                      placeholder="Core mobile application"
                      value={newProjectDesc}
                      onChange={(e) => setNewProjectDesc(e.target.value)}
                      className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-3 py-1.5 rounded-md text-[11px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mb-1">Local Path (Optional)</span>
                    <input
                      type="text"
                      placeholder="Local absolute path"
                      value={newProjectLocalPath}
                      onChange={(e) => setNewProjectLocalPath(e.target.value)}
                      className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-3 py-1.5 rounded-md text-[11px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono"
                    />
                  </div>
                  <div>
                    <span className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold block mb-1">Task ID Prefix (Optional)</span>
                    <input
                      type="text"
                      placeholder="e.g. DVF"
                      value={newProjectTaskIdPrefix}
                      onChange={(e) => setNewProjectTaskIdPrefix(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
                      className="w-full bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-3 py-1.5 rounded-md text-[11px] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono"
                    />
                  </div>
                </div>

                <div className="flex gap-2 pt-2 text-[11px]">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsAddingProject(false);
                    }}
                    className="flex-1 font-bold border border-[#ebdcb9] dark:border-[#584a3b] py-2 rounded-md hover:bg-[#fff9ef] dark:bg-[#1e1914] dark:hover:bg-[#292119] text-[#7a6455] dark:text-[#f3eadf] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="flex-1 bg-[#d89745] dark:bg-[#e0a070] hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] py-2 rounded-md font-extrabold transition-colors shadow-sm"
                  >
                    Link Repo
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      {/* Stats Section with beautiful orange values */}
      <div className="px-6 py-2 border-b border-[#e5d4bb] dark:border-[#584a3b]">
        <h3 className="text-[10px] font-bold text-[#8C7565] dark:text-[#f3eadf] uppercase tracking-widest mb-3.5 flex items-center gap-1.5">
          <TrendingUp size={12} className="text-[#df9433] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Work Progress
        </h3>
        
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-[#fffbf6] dark:bg-[#292119] p-2.5 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] shadow-2xs">
            <p className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold font-mono">COMPLETED</p>
            <p className="text-sm font-extrabold text-[#534135] dark:text-[#f3eadf] mt-1">
              {completedTasks} <span className="text-[9px] font-normal text-[#9b8577] dark:text-[#d6b56d] font-mono">/ {totalTasks}</span>
            </p>
            <div className="w-full bg-[#ebdcb9] dark:bg-[#584a3b] h-1.5 rounded-full mt-2 overflow-hidden">
              <div 
                className="bg-[#38b000] dark:bg-[#d6b56d] dark:bg-[#e0a070] h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0}%` }}
              />
            </div>
          </div>

          <div className="bg-[#fffbf6] dark:bg-[#292119] p-2.5 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] flex flex-col justify-between shadow-2xs">
            <div>
              <p className="text-[9px] text-[#8C7565] dark:text-[#f3eadf] font-bold font-mono">ACTIVE SPECS</p>
              <p className="text-sm font-extrabold text-[#d8913b] dark:text-[#d6b56d] mt-1 flex items-center gap-1">
                ⚙️ {activeBranches.length}
              </p>
            </div>
            <p className="text-[8px] text-[#917d71] dark:text-[#d6b56d] truncate font-mono mt-1">working branches</p>
          </div>
        </div>
      </div>

      {/* Scrollable Filters section */}
      <div className="p-6 flex-1 overflow-y-auto space-y-6 scrollbar-thin">
        
        {/* Search Input */}
        <div className="space-y-1.5">
          <label className="text-[9px] font-bold text-[#8C7565] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5">
            <Filter size={11} className="text-[#bf843e] dark:text-[#f3eadf]" /> Find Ticket
          </label>
          <input
            type="text"
            className="w-full bg-[#fdfaf5] dark:bg-[#292119] border border-[#e5d4bb] dark:border-[#584a3b] rounded-xl px-3.5 py-2 text-[11px] text-[#534135] dark:text-[#f3eadf] placeholder-[#c3b19e] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono transition-all"
            placeholder="Type files or keys..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Priority Filter */}
        <div className="space-y-2">
          <label className="text-[9px] font-bold text-[#8C7565] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5">
            <Flame size={12} className="text-[#de6b48] dark:text-[#df6b4f]" /> Task Urgency
          </label>
          <div className="space-y-1">
            <button
              onClick={() => setSelectedPriority('all')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'all' 
                  ? 'bg-[#ffeace] dark:bg-[#292119] border-[#e7bc8c] dark:border-[#584a3b] text-[#714a1a] dark:text-[#f3eadf] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] dark:text-[#f3eadf] border-transparent dark:border-transparent hover:bg-[#fff9f1] dark:hover:bg-[#292119] hover:text-[#534135] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
              }`}
            >
              <span>★ All Tickets</span>
              <span className="text-[9px] bg-[#ebd6bc]/60 dark:bg-[#292119]/60 text-[#7c624d] dark:text-[#f3eadf] px-1.5 py-0.5 rounded-full font-bold">{totalTasks}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('high')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'high' 
                  ? 'bg-[#ffdacf] dark:bg-[#292119] border-[#ffa995] dark:border-[#584a3b] text-[#b43a20] dark:text-[#df6b4f] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] dark:text-[#f3eadf] border-transparent dark:border-transparent hover:bg-[#fff9f1] dark:hover:bg-[#292119] hover:text-[#534135] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#de6b48] dark:bg-[#df6b4f]" />
                <span>High Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 dark:bg-[#292119]/60 text-[#7c624d] dark:text-[#f3eadf] px-1.5 py-0.5 rounded-full font-bold">{highPriorityCount}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('medium')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'medium' 
                  ? 'bg-[#ffecca] dark:bg-[#292119] border-[#f0cca3] dark:border-[#584a3b] text-[#a46c24] dark:text-[#d6a549] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] dark:text-[#f3eadf] border-transparent dark:border-transparent hover:bg-[#fff9f1] dark:hover:bg-[#292119] hover:text-[#534135] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#e5a93b] dark:bg-[#d6a549]" />
                <span>Medium Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 dark:bg-[#292119]/60 text-[#7c624d] dark:text-[#f3eadf] px-1.5 py-0.5 rounded-full font-bold">{mediumPriorityCount}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('low')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'low' 
                  ? 'bg-[#e2f0dc] dark:bg-[#292119] border-[#bddda4] dark:border-[#584a3b] text-[#4d7e35] dark:text-[#8fce7c] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] dark:text-[#f3eadf] border-transparent dark:border-transparent hover:bg-[#fff9f1] dark:hover:bg-[#292119] hover:text-[#534135] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7dad71] dark:bg-[#8fce7c]" />
                <span>Low Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 dark:bg-[#292119]/60 text-[#7c624d] dark:text-[#f3eadf] px-1.5 py-0.5 rounded-full font-bold">{lowPriorityCount}</span>
            </button>
          </div>
        </div>

      </div>

      {/* Decorative Bottom */}
      <div className="p-4 border-t border-[#e5d4bb] dark:border-[#584a3b] bg-[#ede0c9]/50 dark:bg-[#292119]/50 flex items-center justify-between text-[10px] text-[#816b5a] dark:text-[#f3eadf] font-mono">
        <span>✨ Stay focused, build beautifully.</span>
        <button
          onClick={onOpenSettings}
          title="Open Settings"
          className="flex items-center gap-1.5 text-[#b89b82] dark:text-[#d6b56d] hover:text-[#935919] dark:hover:text-[#e0a070] dark:text-[#d6b56d] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 px-2 py-1 rounded-lg transition-colors"
        >
          <Settings size={13} />
          <span className="font-bold">Settings</span>
        </button>
      </div>
    </aside>
  );
}
