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
  Coffee,
  Smile,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Settings,
  Waypoints
} from 'lucide-react';
import { Task, TaskPriority, Project } from '../types';

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
  activePage?: 'board' | 'atlas';
  onSetActivePage?: (page: 'board' | 'atlas') => void;
  isAtlasSidebarCollapsed?: boolean;
  onToggleAtlasSidebar?: () => void;
}

export { formatProjectRepoLabel } from './ProjectSwitcher';

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
  isAtlasSidebarCollapsed = false,
  onToggleAtlasSidebar,
}: SidebarProps) {
  const [hearts, setHearts] = useState<{ id: number; x: number; y: number }[]>([]);
  const [cozySpeak, setCozySpeak] = useState('☕ Fuel configured! Time to inspect some specifications.');
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

  if (activePage === 'atlas' && isAtlasSidebarCollapsed) {
    const activeProject = projects.find(p => p.id === activeProjectId);
    return (
      <aside className="hidden h-full w-16 shrink-0 select-none flex-col border-r border-[#e5d4bb] bg-[#fffdfa] px-2 py-3 dark:border-[#584a3b] dark:bg-[#292119] lg:flex">
        <button
          type="button"
          onClick={onToggleAtlasSidebar}
          title="Expand sidebar"
          className="mb-3 flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-[#d8c5aa] bg-[#fff7ec] text-[#a46c24] hover:bg-[#ffeace] dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#d6b56d] dark:hover:bg-[#3a2f26]"
        >
          <ChevronRight size={18} />
        </button>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[#e5a043] bg-[#ffb766] text-[#553108] dark:border-[#584a3b] dark:bg-[#e0a070] dark:text-[#2b1b0f]" title="CozyFlow">
          <Coffee size={20} />
        </div>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            onClick={() => onSetActivePage?.('atlas')}
            title="Project Atlas"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-[#d89745] bg-[#ffeace] text-[#714a1a] dark:border-[#f0b84d] dark:bg-[#3a2f26] dark:text-[#f3eadf]"
          >
            <Waypoints size={18} />
          </button>
          <button
            type="button"
            onClick={() => onSetActivePage?.('board')}
            title="Sprint Board"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-[#e5d4bb] bg-[#fff7ec] text-[#a46c24] hover:bg-[#ffeace] dark:border-[#6d5642] dark:bg-[#2b2119] dark:text-[#d6b56d] dark:hover:bg-[#3a2f26]"
          >
            <FolderGit size={18} />
          </button>
        </div>
        <div className="mt-4 h-px bg-[#e5d4bb] dark:bg-[#584a3b]" />
        <div className="mt-4 flex min-h-0 flex-1 flex-col items-center gap-2">
          <div className="[writing-mode:vertical-rl] max-h-56 rotate-180 truncate text-[10px] font-black uppercase tracking-widest text-[#9a5b13] dark:text-[#d6b56d]" title={activeProject?.name}>
            {activeProject?.taskIdPrefix || activeProject?.name || 'Atlas'}
          </div>
          <span className="rounded-full border border-[#e0c7a8] bg-[#fff7eb] px-1.5 py-1 text-[9px] font-black text-[#9a5b13] dark:border-[#6d5642] dark:bg-[#2b2119] dark:text-[#f0b84d]" title="Task count">
            {totalTasks}
          </span>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          title="Settings"
          className="mt-auto flex h-10 w-10 cursor-pointer items-center justify-center rounded-xl border border-[#e5d4bb] bg-[#fff7ec] text-[#a46c24] hover:bg-[#ffeace] dark:border-[#6d5642] dark:bg-[#2b2119] dark:text-[#d6b56d] dark:hover:bg-[#3a2f26]"
        >
          <Settings size={17} />
        </button>
      </aside>
    );
  }

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
    <aside className="w-full bg-[#f4ebd9] lg:w-72 dark:bg-[#292119] border-b lg:border-b-0 lg:border-r border-[#e5d4bb] dark:border-[#584a3b] flex flex-col h-auto lg:h-full shrink-0 select-none">
      
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
            {activePage === 'atlas' && (
              <button
                type="button"
                onClick={onToggleAtlasSidebar}
                title="Collapse sidebar"
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-lg border border-[#d8c5aa] bg-[#fff7ec] text-[#a46c24] hover:bg-[#ffeace] dark:border-[#584a3b] dark:bg-[#1e1914] dark:text-[#d6b56d]"
              >
                <ChevronLeft size={16} />
              </button>
            )}
          </div>

          {/* Dialog Bubble */}
          <div className="bg-[#fffdfb] dark:bg-[#292119] px-3.5 py-2.5 rounded-2xl relative border border-[#e5d4bb] dark:border-[#584a3b] shadow-xs text-[11px] text-[#55453B] dark:text-[#f3eadf] font-mono leading-relaxed">
            <span className="absolute left-5 -top-2 w-3 h-3 bg-[#fffdfb] dark:bg-[#292119] border-t border-l border-[#e5d4bb] dark:border-[#584a3b] rotate-45" />
            <p className="relative z-10">{cozySpeak}</p>
          </div>
        </div>
      </div>

      {/* Stats Section with beautiful orange values */}
      <div className="px-6 py-2 border-b border-[#e5d4bb] dark:border-[#584a3b]">
        <div className="mb-4 grid grid-cols-1 gap-2">
          <button
            type="button"
            onClick={() => onSetActivePage?.('board')}
            className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-[11px] font-extrabold transition-colors ${
              activePage === 'board'
                ? 'bg-[#ffeace] border-[#e7bc8c] text-[#714a1a] dark:bg-[#3a2f26] dark:border-[#584a3b] dark:text-[#f3eadf]'
                : 'bg-[#fffbf6] border-[#e5d4bb] text-[#6e584a] hover:bg-[#fff9f1] dark:bg-[#1e1914] dark:border-[#584a3b] dark:text-[#f3eadf]'
            }`}
          >
            <span className="flex items-center gap-2"><FolderGit size={14} /> Sprint Board</span>
            <span className="font-mono text-[9px]">{totalTasks}</span>
          </button>
          <button
            type="button"
            onClick={() => onSetActivePage?.('atlas')}
            className={`flex items-center justify-between rounded-xl border px-3 py-2 text-left text-[11px] font-extrabold transition-colors ${
              activePage === 'atlas'
                ? 'bg-[#ffeace] border-[#e7bc8c] text-[#714a1a] dark:bg-[#3a2f26] dark:border-[#584a3b] dark:text-[#f3eadf]'
                : 'bg-[#fffbf6] border-[#e5d4bb] text-[#6e584a] hover:bg-[#fff9f1] dark:bg-[#1e1914] dark:border-[#584a3b] dark:text-[#f3eadf]'
            }`}
          >
            <span className="flex items-center gap-2"><Waypoints size={14} /> Project Atlas</span>
            <span className="font-mono text-[9px]">Graph</span>
          </button>
        </div>
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
