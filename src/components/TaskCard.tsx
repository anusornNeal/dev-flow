/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { GitBranch, Copy, Check, Trash2, FileCode, CheckSquare, Image as ImageIcon, Link as LinkIcon, Lock } from 'lucide-react';
import { Task } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';

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
  const [isDrag, setIsDrag] = useState(false);

  const handleCopyBranch = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!task.branch) return;
    navigator.clipboard.writeText(`git checkout -b ${task.branch}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
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
          ? 'border-dashed border-[#e6b47c] bg-[#faf6ef]/50 opacity-60' 
          : isInProgress
            ? 'bg-[#ffffff] border-2 border-[#e3a35a] shadow-md ring-[4px] ring-[#f8ebd9]/40'
            : isDone
              ? 'bg-[#f7fdf7] border-[#d4ece3] border-l-4 border-l-emerald-500 shadow-2xs'
              : 'bg-[#ffffff] border-[#e8dfcf] hover:border-[#cfc3b0] shadow-sm hover:shadow-md'
      }`}
      id={`task-card-${task.id}`}
    >
      {/* Warm Priority Left Indicator Slider for non-active cards */}
      {!isDone && !isInProgress && (
        <span 
          className={`w-1 h-8 absolute left-0 top-1/2 -translate-y-1/2 rounded-r-md ${
            task.priority === 'high' ? 'bg-[#de6b48]' : 
            task.priority === 'medium' ? 'bg-[#e5a93b]' : 
            'bg-[#7dad71]'
          }`}
        />
      )}

      {/* Header Tags & Delete button */}
      <div>
        <div className="flex justify-between items-center gap-2 mb-2 pl-0.5">
          <div className="flex items-center gap-2.5">
            {/* Sleek Priority dot */}
            <span className={`flex items-center gap-1.5 text-[9px] uppercase font-mono tracking-wider font-extrabold px-2 py-0.5 rounded-lg border ${
              isDone ? 'bg-[#f0f0f0] text-gray-400 border-gray-200' :
              task.priority === 'high' ? 'bg-[#ffdacf] text-[#b43a20] border-[#ffa995]' :
              task.priority === 'medium' ? 'bg-[#ffecca] text-[#a46c24] border-[#f0cca3]' :
              'bg-[#e2f0dc] text-[#4d7e35] border-[#bddda4]'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                task.priority === 'high' ? 'bg-[#e05230]' :
                task.priority === 'medium' ? 'bg-[#d28b26]' :
                'bg-[#5b8c47]'
              }`} />
              {task.priority}
            </span>

            {isInProgress && (
              <span className="flex h-1.5 w-1.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-500"></span>
              </span>
            )}

            {/* Lock badge - shown when an agent is actively working */}
            {task.activeAgent && (
              <span className="flex items-center gap-1 text-[8.5px] font-mono font-extrabold px-1.5 py-0.5 rounded-lg bg-orange-50 text-orange-700 border border-orange-200 select-none" title={`Locked by ${task.activeAgent}`}>
                <Lock size={8} className="shrink-0" />
                {task.activeAgent}
              </span>
            )}
            
            <span className="text-[9.5px] font-bold text-[#b49f8e] font-mono leading-none">
              #{task.displayId || task.id}
            </span>
          </div>
          
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            type="button"
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 p-1.5 rounded-full hover:bg-[#fff0ed] transition-all cursor-pointer duration-150"
            title="Remove card"
          >
            <Trash2 size={13} />
          </button>
        </div>

        {/* Title text */}
        <h3 className={`text-xs leading-relaxed mb-3.5 font-sans line-clamp-2 pl-0.5 select-text selection:bg-[#ffd9aa] select-none ${
          isDone ? 'text-gray-400 line-through font-normal' : 'text-[#3e3129] font-extrabold'
        }`}>
          {task.title}
        </h3>

        {/* Card Thumbnail Preview (if design image is attached) */}
        {((task.designImages && task.designImages.length > 0) || task.designImage) && (
          <div className="relative mb-3 rounded-xl overflow-hidden border border-[#ebdcb9] h-14 bg-white/50 pl-0.5">
            <img 
              src={(task.designImages && task.designImages[0]) || task.designImage} 
              alt="Design Preview" 
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" 
              referrerPolicy="no-referrer"
            />
            {task.designImages && task.designImages.length > 1 && (
              <div className="absolute top-1 right-1 bg-black/60 backdrop-blur-md text-white text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm border border-white/20">
                +{task.designImages.length - 1}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Structured files/checklist progress details */}
      {(filesCount > 0 || totalSteps > 0) && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5 px-0.5 text-[9.5px] font-mono text-[#7a6455]">
          {filesCount > 0 && (
            <span className="flex items-center gap-1 bg-[#ede6dc]/30 border border-[#e8dfcf] px-2 py-0.5 rounded-lg font-bold">
              📁 {filesCount} {filesCount === 1 ? 'file' : 'files'}
            </span>
          )}
          {totalSteps > 0 && (
            <span className={`flex items-center gap-1 border px-2 py-0.5 rounded-lg font-bold ${
              completedSteps === totalSteps 
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60' 
                : 'bg-[#fffcf4] text-[#a47a32] border-[#f0e3cc]'
            }`}>
              ✓ {completedSteps}/{totalSteps} steps
            </span>
          )}
        </div>
      )}

      {/* Design mock and Spec sheet indicators */}
      {((task.designImages && task.designImages.length > 0) || task.designImage || task.specUrl) && (
        <div className="flex flex-wrap items-center gap-2 mb-3 px-0.5 text-[8.5px] font-mono font-extrabold uppercase select-none">
          {((task.designImages && task.designImages.length > 0) || task.designImage) && (
            <span className="flex items-center gap-1 bg-[#fff2e0] text-[#9a6428] border border-[#fde5bd] px-1.5 py-0.5 rounded-lg">
              <ImageIcon size={10} /> Design Doc {task.designImages && task.designImages.length > 1 && `(${task.designImages.length})`}
            </span>
          )}
          {task.specUrl && (
            <span className="flex items-center gap-1 bg-[#e0f1f7] text-[#2c6e85] border border-[#cbe4ee] px-1.5 py-0.5 rounded-lg">
              <LinkIcon size={10} /> Spec Link
            </span>
          )}
        </div>
      )}

      {/* Git Branch Copy Trigger */}
      {task.branch && (
        <div 
          onClick={handleCopyBranch}
          className={`group/branch mb-3 mx-0.5 p-2 rounded-xl border flex items-center justify-between text-[10px] font-mono font-medium cursor-pointer transition-all active:scale-[0.98] ${
            isDone 
              ? 'bg-[#f8f5ee] border-[#ebdcb9] text-gray-400 border-dashed hover:border-gray-400'
              : isInProgress
                ? 'bg-[#fff9e6] border-[#fde5bd] text-[#935919] hover:bg-[#fff5d3] hover:border-[#fbc58e]'
                : 'bg-[#faf7f0] border-[#ebdcb9] text-[#715c4d] hover:bg-[#fff9e6] hover:border-[#fde5bd]'
          }`}
          title="Click to copy Git Branch instruction"
        >
          <div className="flex items-center gap-1.5 truncate">
            <GitBranch size={11} className={`${isDone ? 'text-emerald-500' : 'text-[#d89745]'} shrink-0 group-hover/branch:rotate-12 transition-transform`} />
            <span className="truncate">{task.branch}</span>
          </div>
          <button
            type="button"
            className="text-gray-400 group-hover/branch:text-[#d89745] shrink-0 transition-colors"
          >
            {copied ? (
              <Check size={11} className="text-emerald-500 animate-scale" />
            ) : (
              <Copy size={11} />
            )}
          </button>
        </div>
      )}

      {/* Subtasks compact section */}
      {subtasks && subtasks.length > 0 && (
        <div className="mt-2.5 mb-2.5 p-2 bg-[#fdfbf8]/90 border border-[#ede3d2] rounded-xl flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center text-[9px] font-mono font-extrabold uppercase text-[#7a6455] tracking-wide mb-1 select-none">
            <span className="flex items-center gap-1">🌿 Subtasks ({subtasks.filter(s => s.status === 'done').length}/{subtasks.length})</span>
            <span className="text-[#a47a32]">{Math.round((subtasks.filter(s => s.status === 'done').length / subtasks.length) * 100)}% done</span>
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
                  className={`group/sub flex flex-col gap-1 p-1.5 rounded-xl border text-[10px] cursor-grab active:cursor-grabbing transition-all hover:bg-white select-none ${
                    subDone 
                      ? 'bg-emerald-50/20 border-emerald-100/50 text-gray-400' 
                      : subInProgress
                        ? 'bg-orange-50/40 border-orange-100 text-[#715c4d] font-semibold'
                        : 'bg-[#faf8f5]/60 border-[#ebdcb9]/20 text-[#5c493c]'
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
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all cursor-pointer ${
                        subDone 
                          ? 'bg-emerald-500 border-emerald-500 text-white' 
                          : 'bg-white border-[#ebdcb9] hover:border-[#d4994e]'
                      }`}
                    >
                      {subDone && <span className="text-[8px] leading-none mb-0.5">✓</span>}
                    </button>
                    <span className={`truncate flex-1 hover:underline text-[9.5px] font-sans ${subDone ? 'line-through' : ''}`}>{sub.title}</span>
                  </div>
                  
                  {/* Small statuses/agent info */}
                  <div className="flex items-center gap-1 shrink-0 font-mono text-[7.5px] font-bold ml-[19px]">
                    {sub.model && (
                      <span className="px-1 py-0.2 rounded border bg-[#fae8ff] text-[#86198f] border-[#f5d0fe]">
                        {sub.model}
                      </span>
                    )}
                    <span className={`px-1 py-0.2 rounded uppercase border ${
                      subDone ? 'bg-emerald-50 text-emerald-700 border-emerald-200/40' :
                      subInProgress ? 'bg-orange-50 text-orange-700 border-orange-200/40' :
                      sub.status === 'todo' ? 'bg-[#fffdf4] text-[#a47a32] border-[#f0e3cc]' :
                      'bg-gray-50 text-gray-400 border-gray-200'
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

      {/* Agent & Model Selectors */}
      <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[#f2ece2]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-1.5">
          {/* Agent Selector */}
          <div className="relative flex-1 min-w-0">
            <select
              value={task.agent || ''}
              onChange={(e) => {
                const val = e.target.value;
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
              }}
              className="w-full bg-[#fdfbf7] hover:bg-white border border-[#ebdcb9] hover:border-[#d4994e] rounded-xl text-[9px] py-1 px-1.5 focus:border-[#d4994e] outline-none text-[#564436] font-sans font-bold transition-all cursor-pointer truncate"
            >
              <option value="">👤 Unassigned</option>
              <option value="Codex">🤖 Codex</option>
              <option value="Antigravity">🤖 Antigravity</option>
              <option value="Claude">🤖 Claude</option>
            </select>
          </div>

          {/* Model Selector */}
          <div className="relative flex-1 min-w-0">
            <select
              value={task.model || ''}
              disabled={!task.agent}
              onChange={(e) => {
                const val = e.target.value;
                if (onUpdate) {
                  const defaultEffort = (task.agent && val) ? defaultEffortForModel(task.agent, val) : '';
                  onUpdate({
                    ...task,
                    model: val || undefined,
                    effort: defaultEffort || undefined
                  });
                }
              }}
              className="w-full bg-[#fdfbf7] hover:bg-white border border-[#ebdcb9] hover:border-[#d4994e] rounded-xl text-[9px] py-1 px-1.5 focus:border-[#d4994e] outline-none text-[#564436] font-sans font-bold transition-all cursor-pointer truncate disabled:opacity-50"
            >
              <option value="">⚡ Default Model</option>
              {task.agent && AGENTS_CONFIG[task.agent as import('../lib/agentsConfig').AgentName]?.map(m => (
                <option key={m.model_name} value={m.model_name}>
                  {m.model_name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Small badge display for effort if assigned */}
        {task.agent && task.model && task.effort && (
          <div className="flex flex-wrap items-center gap-1 mt-0.5 select-none font-mono text-[7px] font-bold">
            <span className="px-1 py-0.2 rounded bg-[#f1f5f9] text-[#475569] border border-[#e2e8f0]">
              ⚡ {task.effort.toUpperCase()} EFFORT
            </span>
          </div>
        )}

        {/* Footer Metrics */}
        <div className="flex items-center justify-between pt-0.5 select-none text-[9px] font-mono">
          <span className="text-[#a59082] italic">
            {task.branch ? 'git checkouts configured' : 'no active branch'}
          </span>
          <div className="flex items-center gap-2 font-mono shrink-0">
            <span className="text-[#9e8b7c] font-bold" title="Last updated">
              {isDone ? '✓ merged' : formattedDate}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
