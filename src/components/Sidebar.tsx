/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
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
  ExternalLink
} from 'lucide-react';
import { Task, TaskPriority, Project } from '../types';

interface SidebarProps {
  tasks: Task[];
  projects: Project[];
  activeProjectId: string;
  setActiveProjectId: (id: string) => void;
  onCreateProject: (name: string, repoUrl: string, description?: string) => Promise<boolean>;
  onDeleteProject: (id: string) => Promise<boolean>;
  selectedPriority: TaskPriority | 'all';
  setSelectedPriority: (priority: TaskPriority | 'all') => void;
  selectedTag: string | 'all';
  setSelectedTag: (tag: string | 'all') => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export default function Sidebar({
  tasks,
  projects,
  activeProjectId,
  setActiveProjectId,
  onCreateProject,
  onDeleteProject,
  selectedPriority,
  setSelectedPriority,
  selectedTag,
  setSelectedTag,
  searchQuery,
  setSearchQuery
}: SidebarProps) {
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const [cozySpeak, setCozySpeak] = useState('☕ Fuel configured! Time to inspect some specifications.');
  const [isProjectDropdownOpen, setIsProjectDropdownOpen] = useState(false);
  const [isAddingProject, setIsAddingProject] = useState(false);
  const [newProjectName, setNewProjectName] = useState('');
  const [newProjectRepoUrl, setNewProjectRepoUrl] = useState('');
  const [newProjectDesc, setNewProjectDesc] = useState('');
  
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
    <aside className="w-full lg:w-72 bg-[#f4ebd9] border-b lg:border-b-0 lg:border-r border-[#e5d4bb] flex flex-col h-full shrink-0 select-none">
      
      {/* Cozy Warm Mascot Header */}
      <div className="p-6 border-b border-[#e5d4bb] bg-[#ede0c9]">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <button
              onClick={handleEnjoyCoffee}
              type="button"
              className="relative bg-[#ffb766] hover:bg-[#ffa23b] p-3 rounded-full border border-[#e5a043] shadow-sm transition-all active:scale-90 group cursor-pointer animate-pulse"
              title="Click to take a sip of espresso!"
            >
              <Coffee size={24} className="text-[#553108] group-hover:scale-110 transition-transform" />
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
              <h2 className="text-xs font-extrabold text-[#534135] tracking-wide flex items-center gap-1.5 leading-none">
                ✨ CozyFlow
              </h2>
              <span className="text-[10px] text-[#8C7565] font-bold block mt-1">
                Minimalist Spec Space
              </span>
            </div>
          </div>

          {/* Dialog Bubble */}
          <div className="bg-[#fffdfb] px-3.5 py-2.5 rounded-2xl relative border border-[#e5d4bb] shadow-xs text-[11px] text-[#55453B] font-mono leading-relaxed">
            <span className="absolute left-5 -top-2 w-3 h-3 bg-[#fffdfb] border-t border-l border-[#e5d4bb] rotate-45" />
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
          }}
          type="button"
          className="w-full text-left p-4 bg-[#fdfaf5] hover:bg-[#fffdf8] rounded-xl border border-[#e5d4bb] flex items-center justify-between gap-2.5 shadow-xs cursor-pointer transition-all active:scale-[0.99]"
        >
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <Sparkles size={15} className="text-[#d89745] shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-[9px] text-[#8C7565] font-bold tracking-wider uppercase flex items-center gap-1.5">
                ACTIVE WORKSPACE
              </p>
              <p className="text-[11px] font-extrabold text-[#534135] truncate">
                {projects.find(p => p.id === activeProjectId)?.name || 'Developer Sandbox Repo'}
              </p>
              {projects.find(p => p.id === activeProjectId)?.repoUrl && (
                <p className="text-[8px] text-[#9b8271] font-mono truncate max-w-full">
                  🔗 {projects.find(p => p.id === activeProjectId)?.repoUrl.replace(/^https?:\/\/(www\.)?/, '')}
                </p>
              )}
            </div>
          </div>
          {isProjectDropdownOpen ? (
            <ChevronUp size={14} className="text-[#8c7463]" />
          ) : (
            <ChevronDown size={14} className="text-[#8c7463]" />
          )}
        </button>

        {isProjectDropdownOpen && (
          <div className="absolute top-13 left-0 right-0 z-30 bg-[#fffefd] border border-[#d8c5aa] rounded-xl shadow-lg p-3 space-y-2 text-xs font-sans">
            {!isAddingProject ? (
              <>
                <p className="text-[9px] text-[#8C7565] font-bold uppercase tracking-widest border-b border-[#f1e6d4] pb-1.5 mb-1">
                  Selected Repository
                </p>
                <div className="space-y-1.5 max-h-56 overflow-y-auto scrollbar-thin">
                  {projects.map((project) => {
                    const isActive = project.id === activeProjectId;
                    return (
                      <div
                        key={project.id}
                        onClick={() => {
                          setActiveProjectId(project.id);
                          setIsProjectDropdownOpen(false);
                        }}
                        className={`p-2 rounded-lg border flex items-center justify-between gap-2 cursor-pointer transition-all ${
                          isActive
                            ? 'bg-[#ffeecd] border-[#e4be93] text-[#69441a]'
                            : 'bg-white hover:bg-[#fff9ee] border-[#ebdcb9] text-[#55453B]'
                        }`}
                      >
                        <div className="min-w-0 flex-1">
                          <p className="font-extrabold text-[11px] truncate flex items-center gap-1">
                            {isActive && '✨'} {project.name}
                          </p>
                          <p className="text-[9px] text-[#917d71] font-mono truncate" title={project.repoUrl}>
                            {project.repoUrl.replace(/^https?:\/\/(www\.)?/, '')}
                          </p>
                        </div>
                        
                        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                          <a
                            href={project.repoUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1 text-gray-400 hover:text-[#d89745] transition-colors"
                            title="Open repository link in a new tab"
                          >
                            <ExternalLink size={12} />
                          </a>
                          
                          {project.id !== 'project-default' && (
                            <button
                              onClick={() => {
                                if (confirm(`Are you sure you want to delete project "${project.name}" and all its tasks?`)) {
                                  onDeleteProject(project.id);
                                }
                              }}
                              type="button"
                              className="p-1 text-gray-400 hover:text-red-500 transition-colors cursor-pointer"
                              title="Delete project"
                            >
                              <Trash2 size={12} />
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <button
                  onClick={() => setIsAddingProject(true)}
                  type="button"
                  className="w-full mt-2 bg-[#d89745] hover:bg-[#c08234] text-white py-1.5 rounded-lg text-[10px] font-extrabold flex items-center justify-center gap-1 transition-all cursor-pointer"
                >
                  <Plus size={11} /> Bind New Repository
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
                    newProjectDesc.trim()
                  );
                  if (success) {
                    setNewProjectName('');
                    setNewProjectRepoUrl('');
                    setNewProjectDesc('');
                    setIsAddingProject(false);
                  }
                }}
                className="space-y-2 mt-1"
                onClick={(e) => e.stopPropagation()}
              >
                <p className="text-[9px] text-[#8C7565] font-bold uppercase tracking-widest border-b border-[#f1e6d4] pb-1">
                  ➕ Bind New repository
                </p>
                <div className="space-y-1.5 text-[10px]">
                  <div>
                    <span className="text-[8px] text-[#8C7565] font-bold block mb-0.5">Project Name</span>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Android Customer App"
                      value={newProjectName}
                      onChange={(e) => setNewProjectName(e.target.value)}
                      className="w-full bg-white border border-[#ebdcb9] px-2 py-1 rounded-md text-[10px] outline-none focus:border-[#d4994e] font-sans"
                    />
                  </div>
                  <div>
                    <span className="text-[8px] text-[#8C7565] font-bold block mb-0.5">Git Repo URL (HTTPS)</span>
                    <input
                      type="url"
                      required
                      placeholder="https://github.com/user/repo"
                      value={newProjectRepoUrl}
                      onChange={(e) => setNewProjectRepoUrl(e.target.value)}
                      className="w-full bg-white border border-[#ebdcb9] px-2 py-1 rounded-md text-[10px] outline-none focus:border-[#d4994e] font-mono"
                    />
                  </div>
                  <div>
                    <span className="text-[8px] text-[#8C7565] font-bold block mb-0.5">Description (Optional)</span>
                    <input
                      type="text"
                      placeholder="Core mobile application"
                      value={newProjectDesc}
                      onChange={(e) => setNewProjectDesc(e.target.value)}
                      className="w-full bg-white border border-[#ebdcb9] px-2 py-1 rounded-md text-[10px] outline-none focus:border-[#d4994e] font-sans"
                    />
                  </div>
                </div>

                <div className="flex gap-1.5 pt-1 text-[10px]">
                  <button
                    type="button"
                    onClick={() => setIsAddingProject(false)}
                    className="flex-1 border border-[#ebdcb9] py-1 rounded-md hover:bg-[#fff9ef] text-[#7a6455]"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    className="flex-1 bg-[#d89745] hover:bg-[#c08234] text-white py-1 rounded-md font-extrabold"
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
      <div className="px-6 py-2 border-b border-[#e5d4bb]">
        <h3 className="text-[10px] font-bold text-[#8C7565] uppercase tracking-widest mb-3.5 flex items-center gap-1.5">
          <TrendingUp size={12} className="text-[#df9433]" /> Work Progress
        </h3>
        
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="bg-[#fffbf6] p-2.5 rounded-xl border border-[#e5d4bb] shadow-2xs">
            <p className="text-[9px] text-[#8C7565] font-bold font-mono">COMPLETED</p>
            <p className="text-sm font-extrabold text-[#534135] mt-1">
              {completedTasks} <span className="text-[9px] font-normal text-[#9b8577] font-mono">/ {totalTasks}</span>
            </p>
            <div className="w-full bg-[#ebdcb9] h-1.5 rounded-full mt-2 overflow-hidden">
              <div 
                className="bg-[#38b000] h-1.5 rounded-full transition-all duration-500"
                style={{ width: `${totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0}%` }}
              />
            </div>
          </div>

          <div className="bg-[#fffbf6] p-2.5 rounded-xl border border-[#e5d4bb] flex flex-col justify-between shadow-2xs">
            <div>
              <p className="text-[9px] text-[#8C7565] font-bold font-mono">ACTIVE SPECS</p>
              <p className="text-sm font-extrabold text-[#d8913b] mt-1 flex items-center gap-1">
                ⚙️ {activeBranches.length}
              </p>
            </div>
            <p className="text-[8px] text-[#917d71] truncate font-mono mt-1">working branches</p>
          </div>
        </div>
      </div>

      {/* Scrollable Filters section */}
      <div className="p-6 flex-1 overflow-y-auto space-y-6 scrollbar-thin">
        
        {/* Search Input */}
        <div className="space-y-1.5">
          <label className="text-[9px] font-bold text-[#8C7565] uppercase tracking-widest flex items-center gap-1.5">
            <Filter size={11} className="text-[#bf843e]" /> Find Ticket
          </label>
          <input
            type="text"
            className="w-full bg-[#fdfaf5] border border-[#e5d4bb] rounded-xl px-3.5 py-2 text-[11px] text-[#534135] placeholder-[#c3b19e] outline-none focus:border-[#d4994e] font-mono transition-all"
            placeholder="Type files or keys..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* Priority Filter */}
        <div className="space-y-2">
          <label className="text-[9px] font-bold text-[#8C7565] uppercase tracking-widest flex items-center gap-1.5">
            <Flame size={12} className="text-[#de6b48]" /> Task Urgency
          </label>
          <div className="space-y-1">
            <button
              onClick={() => setSelectedPriority('all')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'all' 
                  ? 'bg-[#ffeace] border-[#e7bc8c] text-[#714a1a] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] border-transparent hover:bg-[#fff9f1] hover:text-[#534135]'
              }`}
            >
              <span>★ All Tickets</span>
              <span className="text-[9px] bg-[#ebd6bc]/60 text-[#7c624d] px-1.5 py-0.5 rounded-full font-bold">{totalTasks}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('high')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'high' 
                  ? 'bg-[#ffdacf] border-[#ffa995] text-[#b43a20] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] border-transparent hover:bg-[#fff9f1] hover:text-[#534135]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#de6b48]" />
                <span>High Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 text-[#7c624d] px-1.5 py-0.5 rounded-full font-bold">{highPriorityCount}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('medium')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'medium' 
                  ? 'bg-[#ffecca] border-[#f0cca3] text-[#a46c24] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] border-transparent hover:bg-[#fff9f1] hover:text-[#534135]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#e5a93b]" />
                <span>Medium Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 text-[#7c624d] px-1.5 py-0.5 rounded-full font-bold">{mediumPriorityCount}</span>
            </button>
            <button
              onClick={() => setSelectedPriority('low')}
              className={`w-full text-left text-[11px] px-3 py-2 rounded-xl flex items-center justify-between font-mono transition-all border ${
                selectedPriority === 'low' 
                  ? 'bg-[#e2f0dc] border-[#bddda4] text-[#4d7e35] font-extrabold shadow-2xs' 
                  : 'text-[#6e584a] border-transparent hover:bg-[#fff9f1] hover:text-[#534135]'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#7dad71]" />
                <span>Low Severity</span>
              </div>
              <span className="text-[9px] bg-[#ebd6bc]/60 text-[#7c624d] px-1.5 py-0.5 rounded-full font-bold">{lowPriorityCount}</span>
            </button>
          </div>
        </div>

      </div>

      {/* Decorative Bottom */}
      <div className="p-4 border-t border-[#e5d4bb] bg-[#ede0c9]/50 flex items-center justify-between text-[10px] text-[#816b5a] font-mono">
        <span>✨ Stay focused, build beautifully.</span>
        <span className="tracking-widest">☕ ☕</span>
      </div>
    </aside>
  );
}
