import React, { useState, useRef, useEffect } from 'react';
import { Activity, Cat, Moon, Sun, FileCode, Code, FileText, Plus, Sparkles, Blocks, ChevronDown } from 'lucide-react';
import NgrokStatusPanel from './NgrokStatusPanel';
import AutoWorkToggle from './AutoWorkToggle';
import ChatGptStarterPromptButton from './ChatGptStarterPromptButton';

interface HeaderProps {
  filteredTasksCount: number;
  ngrokUrl: string | null;
  theme: string;
  setTheme: (theme: "light" | "dark") => void;
  setIsSettingsModalOpen: (open: boolean) => void;
  setIsJsonModalOpen: (open: boolean) => void;
  setIsSkillsModalOpen: (open: boolean) => void;
  setIsTemplateModalOpen: (open: boolean) => void;
  setIsObservabilityModalOpen: (open: boolean) => void;
  setIsCreateModalOpen: (open: boolean) => void;
  setIsBatchModalOpen: (open: boolean) => void;
}

export function Header({
  filteredTasksCount,
  ngrokUrl,
  theme,
  setTheme,
  setIsSettingsModalOpen,
  setIsJsonModalOpen,
  setIsSkillsModalOpen,
  setIsTemplateModalOpen,
  setIsCreateModalOpen,
  setIsBatchModalOpen
}: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setIsActionMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <header className="p-4 md:px-6 md:py-4 bg-white/80 dark:bg-[#292119]/80 backdrop-blur-md border-b border-[#e5d4bb]/50 dark:border-[#584a3b]/50 flex flex-col md:flex-row gap-4 justify-between items-start md:items-center sticky top-0 z-10">
      <div>
        <h1 className="text-[#3c2a1a] dark:text-[#f3eadf] font-extrabold font-sans text-lg tracking-tight flex items-center gap-2">
          <Cat className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] shrink-0" size={18} />
          Sprint Backlog
        </h1>
        <p className="text-[11px] text-[#816b5a] dark:text-[#d6b56d] font-mono mt-0.5 font-medium flex items-center gap-1.5">
          <span>Pocket Sandbox</span>
          <span className="w-1 h-1 rounded-full bg-[#dcd0bc] dark:bg-[#d6b56d] dark:bg-[#e0a070]" />
          <span className="font-bold">{filteredTasksCount} tasks</span>
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2.5 w-full md:w-auto">
        <NgrokStatusPanel 
          ngrokUrl={ngrokUrl} 
          onOpenSettings={() => setIsSettingsModalOpen(true)} 
        />
        
        <AutoWorkToggle />

        {/* Theme Toggle */}
        <button
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
          type="button"
          className="p-1.5 text-[#a46c24] dark:text-[#d6b56d] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/50 rounded-xl transition-colors cursor-pointer"
          title="Toggle Dark Mode"
        >
          {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
        </button>

        {/* Secondary Settings Menu */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            type="button"
            className="p-1.5 text-[#a46c24] dark:text-[#d6b56d] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/50 rounded-xl transition-colors cursor-pointer"
            title="Developer Settings & Configs"
          >
            <Blocks size={16} />
          </button>
          
          {isMenuOpen && (
            <div className="absolute right-0 mt-2 bg-white dark:bg-[#292119] rounded-xl shadow-xl border border-[#ebdcb9] dark:border-[#584a3b] py-1.5 min-w-[180px] z-50 flex flex-col overflow-hidden">
              <button
                onClick={() => { setIsJsonModalOpen(true); setIsMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#7a6455] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
              >
                <FileCode size={14} className="text-[#a46c24] dark:text-[#d6b56d]" /> Schema Spec
              </button>
              <button
                onClick={() => { setIsSkillsModalOpen(true); setIsMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#7a6455] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Code size={14} className="text-[#a46c24] dark:text-[#d6b56d]" /> Agent Skills
              </button>
              <button
                onClick={() => { setIsTemplateModalOpen(true); setIsMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#7a6455] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
              >
                <FileText size={14} className="text-[#a46c24] dark:text-[#d6b56d]" /> Prompt Template
              </button>
              <ChatGptStarterPromptButton />
            </div>
          )}
        </div>

        {/* Primary Action Button */}
        <div className="relative ml-1" ref={actionMenuRef}>
          <button
            onClick={() => setIsActionMenuOpen(!isActionMenuOpen)}
            type="button"
            className="bg-[#3c2a1a] hover:bg-[#2a1d12] dark:bg-[#e0a070] dark:hover:bg-[#cc8e60] text-white dark:text-[#292119] px-4 py-1.5 rounded-full text-xs font-extrabold flex items-center gap-1.5 transition-all shadow-sm cursor-pointer"
          >
            <Plus size={14} /> New Ticket <ChevronDown size={14} className="opacity-70 ml-0.5" />
          </button>
          {isActionMenuOpen && (
            <div className="absolute right-0 mt-2 bg-white dark:bg-[#292119] rounded-xl shadow-xl border border-[#ebdcb9] dark:border-[#584a3b] py-1.5 min-w-[200px] z-50 flex flex-col overflow-hidden">
              <button
                onClick={() => { setIsCreateModalOpen(true); setIsActionMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
              >
                <Sparkles size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Single Ticket
              </button>
              <button
                onClick={() => { setIsBatchModalOpen(true); setIsActionMenuOpen(false); }}
                className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#3c2a1a] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
              >
                <FileCode size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Batch Import JSON
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

