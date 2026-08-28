import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  Blocks,
  ChevronDown,
  Code,
  FileCode,
  FileText,
  Moon,
  Plus,
  Sparkles,
  Sun,
} from 'lucide-react';

interface HeaderProps {
  filteredTasksCount: number;
  title?: string;
  subtitle?: string;
  contextLabel?: string;
  projectSwitcher?: React.ReactNode;
  showTaskActions?: boolean;
  theme: string;
  setTheme: (theme: 'light' | 'dark') => void;
  setIsSkillsModalOpen: (open: boolean) => void;
  setIsTemplateModalOpen: (open: boolean) => void;
  setIsObservabilityModalOpen: (open: boolean) => void;
  setIsCreateModalOpen: (open: boolean) => void;
  setIsBatchModalOpen: (open: boolean) => void;
}

export function Header({
  filteredTasksCount,
  title = 'Sprint Board',
  subtitle = 'Board',
  contextLabel,
  projectSwitcher,
  showTaskActions = true,
  theme,
  setTheme,
  setIsSkillsModalOpen,
  setIsTemplateModalOpen,
  setIsObservabilityModalOpen,
  setIsCreateModalOpen,
  setIsBatchModalOpen,
}: HeaderProps) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  const utilityButtonRef = useRef<HTMLButtonElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const firstUtilityItemRef = useRef<HTMLButtonElement>(null);
  const firstActionItemRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setIsActionMenuOpen(false);
      }
    }

    function handleEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      if (isActionMenuOpen) {
        setIsActionMenuOpen(false);
        requestAnimationFrame(() => actionButtonRef.current?.focus());
        return;
      }
      if (isMenuOpen) {
        setIsMenuOpen(false);
        requestAnimationFrame(() => utilityButtonRef.current?.focus());
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isActionMenuOpen, isMenuOpen]);

  useEffect(() => {
    if (isMenuOpen) requestAnimationFrame(() => firstUtilityItemRef.current?.focus());
  }, [isMenuOpen]);

  useEffect(() => {
    if (isActionMenuOpen) requestAnimationFrame(() => firstActionItemRef.current?.focus());
  }, [isActionMenuOpen]);

  const openUtilityMenu = () => {
    setIsActionMenuOpen(false);
    setIsMenuOpen((current) => !current);
  };

  const openActionMenu = () => {
    setIsMenuOpen(false);
    setIsActionMenuOpen((current) => !current);
  };

  return (
    <header className="sticky top-0 z-40 border-b border-df-border bg-df-surface/95 px-4 py-3 shadow-[var(--df-shadow-sm)] backdrop-blur-md md:px-5">
      <div className="flex min-w-0 flex-wrap items-center gap-3 xl:flex-nowrap">
        <div className="min-w-0 shrink-0 xl:max-w-[260px]">
          <div className="flex min-w-0 items-center gap-2">
            <span className="rounded-md border border-df-border bg-df-surface-muted px-2 py-1 text-[9px] font-black uppercase tracking-[0.14em] text-df-accent">
              {subtitle}
            </span>
            <span className="min-w-0 truncate text-[10px] font-semibold text-df-text-muted">
              {contextLabel || `${filteredTasksCount} tasks`}
            </span>
          </div>
          <h1 className="mt-1 truncate text-lg font-extrabold tracking-tight text-df-text" title={title}>
            {title}
          </h1>
        </div>

        {projectSwitcher && (
          <div className="order-3 min-w-0 basis-full xl:order-none xl:min-w-[280px] xl:max-w-[420px] xl:flex-1">
            {projectSwitcher}
          </div>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-2">
          <button
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            type="button"
            className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-transparent text-df-text-muted transition-colors hover:border-df-border hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
            aria-label={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
            title={theme === 'light' ? 'Dark theme' : 'Light theme'}
          >
            {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>

          <div className="relative" ref={menuRef}>
            <button
              ref={utilityButtonRef}
              onClick={openUtilityMenu}
              type="button"
              aria-haspopup="menu"
              aria-expanded={isMenuOpen}
              aria-controls="header-utility-menu"
              className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-lg border border-transparent text-df-text-muted transition-colors hover:border-df-border hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
              title="Developer utilities"
              aria-label="Developer utilities"
            >
              <Blocks size={16} />
            </button>

            {isMenuOpen && (
              <div
                id="header-utility-menu"
                role="menu"
                aria-label="Developer utilities"
                className="absolute right-0 mt-2 flex max-h-[calc(100vh-5rem)] w-[220px] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-df-border bg-df-surface-raised p-1.5 shadow-[var(--df-shadow-lg)]"
              >
                <button
                  ref={firstUtilityItemRef}
                  role="menuitem"
                  onClick={() => { setIsSkillsModalOpen(true); setIsMenuOpen(false); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-bold text-df-text transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                >
                  <Code size={14} className="text-df-accent" /> Agent Skills
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setIsTemplateModalOpen(true); setIsMenuOpen(false); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-bold text-df-text transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                >
                  <FileText size={14} className="text-df-accent" /> Prompt Template
                </button>
                <button
                  role="menuitem"
                  onClick={() => { setIsObservabilityModalOpen(true); setIsMenuOpen(false); }}
                  className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-bold text-df-text transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                >
                  <Activity size={14} className="text-df-accent" /> Observability
                </button>
              </div>
            )}
          </div>

          {showTaskActions && (
            <div className="relative" ref={actionMenuRef}>
              <button
                ref={actionButtonRef}
                onClick={openActionMenu}
                type="button"
                aria-haspopup="menu"
                aria-expanded={isActionMenuOpen}
                aria-controls="header-create-menu"
                className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-df-primary px-3.5 text-[11px] font-extrabold text-[var(--df-color-primary-text)] shadow-[var(--df-shadow-sm)] transition-colors hover:bg-[var(--df-color-primary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
              >
                <Plus size={14} /> New Ticket <ChevronDown size={13} className="opacity-70" />
              </button>
              {isActionMenuOpen && (
                <div
                  id="header-create-menu"
                  role="menu"
                  aria-label="Create ticket"
                  className="absolute right-0 mt-2 flex max-h-[calc(100vh-5rem)] w-[220px] max-w-[calc(100vw-2rem)] flex-col overflow-y-auto rounded-xl border border-df-border bg-df-surface-raised p-1.5 shadow-[var(--df-shadow-lg)]"
                >
                  <button
                    ref={firstActionItemRef}
                    role="menuitem"
                    onClick={() => { setIsCreateModalOpen(true); setIsActionMenuOpen(false); }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-bold text-df-text transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <Sparkles size={14} className="text-df-accent" /> Single Ticket
                  </button>
                  <button
                    role="menuitem"
                    onClick={() => { setIsBatchModalOpen(true); setIsActionMenuOpen(false); }}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-[11px] font-bold text-df-text transition-colors hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]"
                  >
                    <FileCode size={14} className="text-df-accent" /> Batch Import JSON
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
