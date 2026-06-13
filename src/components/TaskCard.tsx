/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect } from 'react';
import { GitBranch, Copy, Check, Trash2, FileCode, CheckSquare, Image as ImageIcon, Link as LinkIcon, Lock, AlertTriangle, Ban, CircleCheck, Bot, Zap, ChevronDown } from 'lucide-react';
import { Task } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel, getDisplayModelName } from '../lib/agentsConfig';
import CopyTemplateButton from './CopyTemplateButton';
import { AgentLogo } from './AgentLogo';

interface TaskCardProps {
  key?: string;
  task: Task;
  subtasks?: Task[];
  onSelect: (task: Task) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onUpdate?: (updatedTask: Task) => void;
}

export default function TaskCard({ task, subtasks = [], onSelect, onDelete, onDragStart, onUpdate }: TaskCardProps) {
  const [copied, setCopied] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [isDrag, setIsDrag] = useState(false);
  const [isEditingAgent, setIsEditingAgent] = useState(false);
  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const editContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (isEditingAgent && editContainerRef.current && !editContainerRef.current.contains(event.target as Node)) {
        setIsEditingAgent(false);
        setAgentMenuOpen(false);
        setModelMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isEditingAgent]);

  const handleCopyBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task.branch) return;
    navigator.clipboard.writeText(`git checkout -b ${task.branch}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyId = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idToCopy = task.displayId || task.id;
    if (!idToCopy) return;
    navigator.clipboard.writeText(idToCopy);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 2000);
  };

  const isDone = task.status === 'done';
  const isInProgress = task.status === 'in-progress';
  const formattedDate = new Date(task.updatedAt).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

  const totalSteps = task.checklist?.length || 0;
  const completedSteps = task.checklist?.filter(item => item.completed).length || 0;
  const filesCount = task.targetFiles?.length || 0;
  const latestRun = task.latestAgentRun;
  const settledRunBadge = latestRun && !task.activeAgent && ['failed', 'cancelled', 'succeeded'].includes(latestRun.status)
    ? latestRun
    : null;



  return (
    <div
      draggable
      onDragStart={(e) => {
        setIsDrag(true);
        onDragStart(e, task.id);
      }}
      onDragEnd={() => setIsDrag(false)}
      onClick={() => onSelect(task)}
      className={`relative select-none transition-all duration-150 flex flex-col justify-between h-fit p-4 rounded-2xl cursor-grab active:cursor-grabbing group border ${
        isDrag 
          ? 'border-dashed border-[#e6b47c] dark:border-[#584a3b] bg-[#faf6ef]/50 dark:bg-[#292119]/50 opacity-60' 
          : isInProgress
            ? 'bg-[#ffffff] dark:bg-[#292119] border-2 border-[#e3a35a] dark:border-[#584a3b] shadow-md ring-[4px] ring-[#f8ebd9]/40 dark:ring-[#292119]/40'
            : isDone
              ? 'bg-[#f7fdf7] dark:bg-[#292119] border-[#d4ece3] dark:border-[#584a3b] border-l-4 border-l-emerald-500 shadow-2xs'
              : 'bg-[#ffffff] dark:bg-[#292119] border-[#e8dfcf] dark:border-[#584a3b] hover:border-[#cfc3b0] dark:hover:border-[#584a3b] shadow-sm hover:shadow-md'
      }`}
      id={`task-card-${task.id}`}
    >
      {/* Warm Priority Left Indicator Slider for non-active cards */}
      {!isDone && !isInProgress && (
        <span 
          className={`w-1 h-8 absolute left-0 top-1/2 -translate-y-1/2 rounded-r-md ${
            task.priority === 'high' ? 'bg-[#de6b48] dark:bg-[#e0a070]' : 
            task.priority === 'medium' ? 'bg-[#e5a93b] dark:bg-[#e0a070]' : 
            'bg-[#7dad71] dark:bg-[#e0a070]'
          }`}
        />
      )}

      <div className="flex flex-col h-full pl-0.5">
        <div className="flex justify-between items-start gap-2 mb-1.5">
          {/* Prominent Task ID & Locked Agent */}
          <div className="flex items-center gap-2">
            <div 
              className="text-[15px] font-mono font-black text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] cursor-pointer hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 px-1.5 -ml-1.5 py-0.5 rounded-md transition-colors flex items-center"
              onClick={(e) => {
                e.stopPropagation();
                handleCopyId(e as any);
              }}
              title="Copy ID"
            >
              #{task.displayId || task.id.slice(0,4)}
              {idCopied && <Check size={13} className="ml-1 text-emerald-500" />}
            </div>
            
            {/* In Progress Key */}
            {isInProgress && (
              <span title="In Progress">
                <svg 
                  xmlns="http://www.w3.org/2000/svg" 
                  width="13" 
                  height="13" 
                  viewBox="0 0 24 24" 
                  fill="none" 
                  stroke="currentColor" 
                  strokeWidth="2.5" 
                  strokeLinecap="round" 
                  strokeLinejoin="round" 
                  className="text-red-500/80 relative -top-[0.5px]"
                >
                  <rect x="5" y="10" width="14" height="11" rx="3.5" />
                  <path d="M8 10V7c0-2.2 1.8-4 4-4s4 1.8 4 4v3" />
                  <circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none" />
                </svg>
              </span>
            )}
          </div>

          <div className="flex gap-1 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => {
                e.stopPropagation();
                onDelete(task.id);
              }}
              type="button"
              className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-[#fff0ed] dark:bg-[#292119] dark:hover:bg-[#292119] transition-all cursor-pointer"
              title="Remove card"
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>

        {/* Title */}
        <h4 className="text-[13px] font-bold text-[#45372d] dark:text-[#f3eadf] leading-snug line-clamp-3 mb-1.5">
          {task.title}
        </h4>

        {/* Locked Agent badge */}
        {task.activeAgent && (
          <div className="mb-3">
            <span className="inline-flex items-center text-[9px] font-mono font-bold text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded shadow-sm border border-orange-100 dark:bg-orange-900/30 dark:border-orange-800" title={`Locked by ${task.activeAgent}`}>
              <AgentLogo agent={task.activeAgent} size={9} className="mr-1" />
              <span>{task.activeAgent}</span>
            </span>
          </div>
        )}

        {/* Card Thumbnail Preview (if design image is attached) */}
        {((task.designImages && task.designImages.length > 0) || task.designImage) && (
          <div className="relative mb-3 mt-1 rounded-lg overflow-hidden border border-[#ebdcb9]/50 dark:border-[#584a3b]/50 h-20 bg-white dark:bg-[#292119]/50">
            <img 
              src={(task.designImages && task.designImages[0]) || task.designImage} 
              alt="Design Preview" 
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300" 
              referrerPolicy="no-referrer"
            />
            {task.designImages && task.designImages.length > 1 && (
              <div className="absolute top-1 right-1 bg-black/60 backdrop-blur-sm text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm">
                +{task.designImages.length - 1}
              </div>
            )}
          </div>
        )}

        {/* Flex filler to push bottom metadata down */}
        <div className="flex-1" />

        {/* Unified Bottom Badge Row -> 2 Row Layout */}
        <div className="flex flex-col gap-1.5 mt-2.5 pt-2.5 border-t border-[#ebdcb9]/30 dark:border-[#584a3b]/30">
          
          {/* Row 1: Files, Checklist, External Links */}
          <div className="flex flex-wrap items-center gap-1.5 w-full">
            {/* Priority */}
            <div className={`w-2 h-2 rounded-full shrink-0 ${
              isDone ? 'bg-gray-300 dark:bg-[#b8ab9f]' :
              task.priority === 'high' ? 'bg-[#e05230] dark:bg-[#e0a070]' :
              task.priority === 'medium' ? 'bg-[#d28b26] dark:bg-[#e0a070]' :
              'bg-[#5b8c47] dark:bg-[#e0a070]'
            }`} title={`Priority: ${task.priority}`} />

            {/* Files */}
            {filesCount > 0 && (
              <span className="flex items-center gap-1 text-[#8a725f] dark:text-[#f3eadf] text-[10px] font-mono font-bold mr-1.5" title={`${filesCount} files`}>
                <FileCode size={12} className="relative -top-[0.5px]" /> 
                <span className="leading-none mt-[1px]">{filesCount}</span>
              </span>
            )}

            {/* Checklist */}
            {totalSteps > 0 && (
              <span className={`flex items-center gap-1 text-[10px] font-mono font-bold mr-1.5 ${
                completedSteps === totalSteps 
                  ? 'text-emerald-600' 
                  : 'text-[#8a725f] dark:text-[#f3eadf]'
              }`} title="Checklist steps">
                <CheckSquare size={12} className="relative -top-[0.5px]" /> 
                <span className="leading-none mt-[1px]">{completedSteps}/{totalSteps}</span>
              </span>
            )}
            
            {/* External Links */}
            {task.specUrl && (
              <span className="flex items-center text-[#2c6e85] dark:text-[#f3eadf] ml-auto" title="Spec Document">
                <LinkIcon size={10} />
              </span>
            )}
          </div>

          {/* Row 2: Agent, Model & Effort */}
          {!isEditingAgent && (
            <div className="flex items-center w-full mt-0.5">
              <span 
                onClick={(e) => { e.stopPropagation(); setIsEditingAgent(true); }}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-[#ebdcb9] dark:border-[#584a3b]/40 bg-[#fdfbf7]/50 dark:bg-[#292119]/50 text-[#8a725f] dark:text-[#f3eadf] text-[9.5px] font-mono font-bold w-full shadow-sm overflow-hidden cursor-pointer hover:bg-[#fffbf4] dark:bg-[#292119] dark:hover:bg-[#382f25] transition-colors"
              >
                {(task.agent || task.model || task.effort) ? (
                  <>
                    <AgentLogo agent={task.model || task.agent} size={12} className="shrink-0 relative -top-[0.5px] text-[#b49f8e] dark:text-[#b8ab9f]" />
                    <span className="leading-none mt-[1px] truncate flex-1 text-left">
                      {getDisplayModelName(task.agent, task.model) || task.agent || 'Agent'}
                    </span>
                    {task.effort && (
                      <>
                        <span className="text-[#ebdcb9] dark:text-[#584a3b] mx-0.5 relative -top-[0.5px] shrink-0">|</span>
                        <Zap size={11} className="relative -top-[0.5px] shrink-0 text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
                        <span className="leading-none mt-[1px] shrink-0">{task.effort}</span>
                      </>
                    )}
                  </>
                ) : (
                  <>
                    <Bot size={12} className="shrink-0 relative -top-[0.5px] text-[#b49f8e]/60 dark:text-[#b8ab9f]/60" />
                    <span className="leading-none mt-[1px] truncate flex-1 text-left italic text-[#8a725f]/60 dark:text-[#f3eadf]/60">
                      Unassigned
                    </span>
                  </>
                )}
              </span>
            </div>
          )}
          {isEditingAgent && (
            <div 
              ref={editContainerRef}
              className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[#ebdcb9] dark:border-[#584a3b]/40 bg-[#fdfbf7]/50 dark:bg-[#292119]/50 text-[#8a725f] dark:text-[#f3eadf] text-[9.5px] font-mono font-bold w-full shadow-sm" 
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-0.5 flex-1 min-w-0">
                {/* Custom Agent Dropdown */}
                <div className="relative flex-1 min-w-0 flex flex-col">
                  <div 
                    onClick={() => { setAgentMenuOpen(!agentMenuOpen); setModelMenuOpen(false); }}
                    className="w-full bg-transparent hover:bg-[#ebdcb9] dark:bg-[#584a3b]/20 dark:hover:bg-[#584a3b]/20 rounded py-0.5 px-0.5 outline-none text-[#8a725f] dark:text-[#f3eadf] font-mono font-bold transition-all cursor-pointer flex items-center justify-between"
                  >
                    <div className="flex items-center gap-1 truncate">
                      {task.agent ? <AgentLogo agent={task.agent} size={11} className="shrink-0" /> : <Bot size={11} className="shrink-0 opacity-60" />}
                      <span className="truncate">{task.agent || 'Unassigned'}</span>
                    </div>
                    <ChevronDown size={10} className="shrink-0 opacity-50 ml-0.5" />
                  </div>
                  
                  {agentMenuOpen && (
                    <div className="absolute top-full left-0 mt-1 w-28 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg shadow-lg z-50 py-1 flex flex-col font-mono text-[9.5px] text-[#8a725f] dark:text-[#f3eadf]">
                      {[
                        { id: '', name: 'Unassigned', icon: <Bot size={11} className="opacity-60" /> },
                        { id: 'Codex', name: 'Codex' },
                        { id: 'Antigravity', name: 'Antigravity' },
                        { id: 'Claude', name: 'Claude' }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-[#ebdcb9]/20 dark:hover:bg-[#584a3b]/20 text-left transition-colors ${task.agent === opt.id ? 'bg-[#ebdcb9]/30 dark:bg-[#584a3b]/30 font-extrabold' : 'font-bold'}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            const val = opt.id;
                            if (onUpdate) {
                              const defaultModel = val ? defaultModelForAgent(val) : '';
                              const defaultEffort = val ? defaultEffortForModel(val, defaultModel) : '';
                              onUpdate({
                                ...task,
                                agent: val || '',
                                model: defaultModel || '',
                                effort: defaultEffort || ''
                              });
                            }
                            setAgentMenuOpen(false);
                          }}
                        >
                          {opt.id ? <AgentLogo agent={opt.id} size={11} className="shrink-0" /> : opt.icon}
                          <span className="truncate">{opt.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>

                {task.agent && (
                  <>
                    <span className="text-[#ebdcb9] dark:text-[#584a3b] shrink-0 mx-0.5">|</span>
                    {/* Custom Model Dropdown */}
                    <div className="relative flex-1 min-w-0 flex flex-col">
                      <div 
                        onClick={() => { setModelMenuOpen(!modelMenuOpen); setAgentMenuOpen(false); }}
                        className="w-full bg-transparent hover:bg-[#ebdcb9] dark:bg-[#584a3b]/20 dark:hover:bg-[#584a3b]/20 rounded py-0.5 px-0.5 outline-none text-[#8a725f] dark:text-[#f3eadf] font-mono font-bold transition-all cursor-pointer flex items-center justify-between"
                      >
                        <span className="truncate">{getDisplayModelName(task.agent, task.model) || 'Default'}</span>
                        <ChevronDown size={10} className="shrink-0 opacity-50 ml-0.5" />
                      </div>
                      
                      {modelMenuOpen && (
                        <div className="absolute top-full left-0 mt-1 w-32 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg shadow-lg z-50 py-1 flex flex-col font-mono text-[9.5px] text-[#8a725f] dark:text-[#f3eadf]">
                          <button
                            className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-[#ebdcb9]/20 dark:hover:bg-[#584a3b]/20 text-left transition-colors ${!task.model ? 'bg-[#ebdcb9]/30 dark:bg-[#584a3b]/30 font-extrabold' : 'font-bold'}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              if (onUpdate) {
                                onUpdate({ ...task, model: undefined, effort: undefined });
                              }
                              setModelMenuOpen(false);
                            }}
                          >
                            <Zap size={11} className="opacity-60 shrink-0 text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
                            <span className="truncate">Default</span>
                          </button>
                          {AGENTS_CONFIG[task.agent as import('../lib/agentsConfig').AgentName]?.map(m => (
                            <button
                              key={m.model_name}
                              className={`flex items-center gap-1.5 px-2 py-1.5 hover:bg-[#ebdcb9]/20 dark:hover:bg-[#584a3b]/20 text-left transition-colors ${task.model === m.model_name ? 'bg-[#ebdcb9]/30 dark:bg-[#584a3b]/30 font-extrabold' : 'font-bold'}`}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (onUpdate) {
                                  onUpdate({
                                    ...task,
                                    model: m.model_name,
                                    effort: defaultEffortForModel(task.agent!, m.model_name)
                                  });
                                }
                                setModelMenuOpen(false);
                              }}
                            >
                              <span className="truncate">{m.display_name || m.model_name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
              <button
                onClick={(e) => { e.stopPropagation(); setIsEditingAgent(false); setAgentMenuOpen(false); setModelMenuOpen(false); }}
                className="shrink-0 ml-1 p-0.5 text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50 dark:hover:bg-emerald-900/30 rounded transition-colors flex items-center justify-center"
                title="Done editing"
              >
                <Check size={11} strokeWidth={3} />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Subtasks compact section */}
      {subtasks && subtasks.length > 0 && (
        <div className="mt-2 p-1.5 bg-[#fdfbf8]/90 dark:bg-[#292119]/90 border border-[#ede3d2] dark:border-[#584a3b] rounded-xl flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center text-[9px] font-mono font-extrabold uppercase text-[#7a6455] dark:text-[#f3eadf] tracking-wide mb-1 select-none">
            <span className="flex items-center gap-1">🌿 Subtasks ({subtasks.filter(s => s.status === 'done').length}/{subtasks.length})</span>
            <span className="text-[#a47a32] dark:text-[#f3eadf]">{Math.round((subtasks.filter(s => s.status === 'done').length / subtasks.length) * 100)}% done</span>
          </div>
          <div className="flex flex-col gap-1 pr-0.5">
            {subtasks.map(sub => {
              const subDone = sub.status === 'done';
              const subInProgress = sub.status === 'in-progress';
              return (
                <div 
                  key={sub.id} 
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    onDragStart(e, sub.id);
                  }}
                  onClick={() => onSelect(sub)}
                  className={`group/sub flex flex-col gap-0.5 p-1 rounded-xl border text-[10px] cursor-grab active:cursor-grabbing transition-all hover:bg-white dark:hover:bg-[#1e1914] select-none ${
                    subDone 
                      ? 'bg-emerald-50/20 border-emerald-100/50 text-gray-400 dark:text-[#b8ab9f]' 
                      : subInProgress
                        ? 'bg-orange-50/40 border-orange-100 text-[#715c4d] dark:text-[#f3eadf] font-semibold'
                        : 'bg-[#faf8f5]/60 dark:bg-[#292119]/60 border-[#ebdcb9]/20 dark:border-[#584a3b]/20 text-[#5c493c] dark:text-[#f3eadf]'
                  }`}
                >
                  <div className="flex items-center gap-1.5 min-w-0 w-full">
                    {/* Tiny Checkbox style toggle */}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onUpdate) {
                          onUpdate({
                            ...sub,
                            status: sub.status === 'done' ? 'todo' : 'done',
                            updatedAt: new Date().toISOString()
                          });
                        }
                      }}
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all cursor-pointer shrink-0 ${
                        subDone 
                          ? 'bg-emerald-500 border-emerald-500 text-white dark:text-[#f3eadf]' 
                          : 'bg-white dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] hover:border-[#d4994e] dark:border-[#e0a070] dark:hover:border-[#584a3b]'
                      }`}
                    >
                      {subDone && <span className="text-[8px] leading-none mb-0.5">✓</span>}
                    </button>
                    <span className={`truncate flex-1 hover:underline text-[10px] font-sans ${subDone ? 'line-through' : ''}`}>{sub.title}</span>
                  </div>
                  
                  {/* Small statuses/agent info */}
                  <div className="flex items-center gap-1 shrink-0 font-mono text-[8px] font-bold ml-[20px]">
                    {sub.model && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border border-[#ebdcb9] dark:border-[#584a3b]/40 bg-[#fdfbf7]/50 dark:bg-[#292119]/50 text-[#8a725f] dark:text-[#f3eadf] shadow-sm">
                        <AgentLogo agent={sub.model} size={8} className="relative -top-[0.5px] text-[#b49f8e] dark:text-[#b8ab9f]" />
                        <span className="leading-none mt-[1px]">{getDisplayModelName(undefined, sub.model)}</span>
                      </span>
                    )}
                    <span className={`px-1 py-0.2 rounded-md uppercase border ${
                      subDone ? 'bg-emerald-50/50 text-emerald-700 border-emerald-200/30' :
                      subInProgress ? 'bg-orange-50/50 text-orange-700 border-orange-200/30' :
                      sub.status === 'todo' ? 'bg-transparent dark:bg-[#292119] text-[#a47a32] dark:text-[#f3eadf] border-[#ebdcb9]/40 dark:border-[#584a3b]' :
                      'bg-transparent dark:bg-[#292119] text-[#8c7a6e] dark:text-[#b8ab9f] border-[#ebdcb9] dark:border-[#584a3b]/30'
                    }`}>
                      {sub.status === 'in-progress' ? 'active' : sub.status}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}



        {/* Footer Metrics */}
        <div className="flex items-center justify-between select-none text-[9px] font-mono mt-2.5 pt-2 border-t border-[#ebdcb9]/40 dark:border-[#584a3b]">
          <span className="text-[#8c7a6e] dark:text-[#d6b56d] italic truncate mr-2" title={task.branch || 'no active branch'}>
            {task.branch ? `🌿 ${task.branch}` : 'no active branch'}
          </span>
          <div className="flex items-center gap-2 font-mono shrink-0">
            <span className="text-[#9e8b7c] dark:text-[#d6b56d] font-bold" title="Last updated">
              {isDone ? '✓ merged' : formattedDate}
            </span>
          </div>
        </div>
    </div>
  );
}
