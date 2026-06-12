/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { GitBranch, Copy, Check, Trash2, FileCode, CheckSquare, Image as ImageIcon, Link as LinkIcon, Lock, AlertTriangle, Ban, CircleCheck } from 'lucide-react';
import { Task } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';
import CopyTemplateButton from './CopyTemplateButton';

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

      {/* Header Tags & Delete button */}
      <div>
        <div className="flex justify-between items-center gap-2 mb-2 pl-0.5">
          <div className="flex items-center gap-2.5">
            {/* Sleek Priority dot */}
            <span className={`flex items-center gap-1.5 text-[9px] uppercase font-mono tracking-wider font-extrabold px-2 py-0.5 rounded-lg border ${
              isDone ? 'bg-[#f0f0f0] dark:bg-[#292119] text-gray-400 dark:text-[#b8ab9f] border-gray-200' :
              task.priority === 'high' ? 'bg-[#ffdacf] dark:bg-[#292119] text-[#b43a20] dark:text-[#f3eadf] border-[#ffa995] dark:border-[#584a3b]' :
              task.priority === 'medium' ? 'bg-[#ffecca] dark:bg-[#292119] text-[#a46c24] dark:text-[#f3eadf] border-[#f0cca3] dark:border-[#584a3b]' :
              'bg-[#e2f0dc] dark:bg-[#292119] text-[#4d7e35] dark:text-[#f3eadf] border-[#bddda4] dark:border-[#584a3b]'
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${
                task.priority === 'high' ? 'bg-[#e05230] dark:bg-[#e0a070]' :
                task.priority === 'medium' ? 'bg-[#d28b26] dark:bg-[#e0a070]' :
                'bg-[#5b8c47] dark:bg-[#e0a070]'
              }`} />
              {task.priority}
            </span>

            {isInProgress && (
              <span className="flex h-1.5 w-1.5 relative">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-orange-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-orange-500"></span>
              </span>
            )}

            {settledRunBadge && (
              <span
                className={`flex items-center gap-1 text-[8.5px] font-mono font-extrabold px-1.5 py-0.5 rounded-lg border select-none ${
                  settledRunBadge.status === 'failed'
                    ? 'bg-red-50 text-red-700 border-red-200'
                    : settledRunBadge.status === 'cancelled'
                      ? 'bg-slate-50 text-slate-600 border-slate-200'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                }`}
                title={settledRunBadge.errorMessage || `Agent run ${settledRunBadge.status}`}
              >
                {settledRunBadge.status === 'failed' ? (
                  <AlertTriangle size={8} className="shrink-0" />
                ) : settledRunBadge.status === 'cancelled' ? (
                  <Ban size={8} className="shrink-0" />
                ) : (
                  <CircleCheck size={8} className="shrink-0" />
                )}
                {settledRunBadge.status}
              </span>
            )}
            
            <button
              type="button"
              onClick={handleCopyId}
              className="flex items-center gap-1.5 px-1.5 py-0.5 -ml-1 rounded hover:bg-[#ebdcb9]/30 dark:hover:bg-[#584a3b]/30 text-[9.5px] font-bold text-[#b49f8e] dark:text-[#d6b56d] hover:text-[#d89745] dark:hover:text-[#e0a070] font-mono leading-none transition-all cursor-pointer"
              title="Copy Card ID"
            >
              #{task.displayId || task.id}
              {idCopied ? (
                <Check size={11} className="text-emerald-500" />
              ) : (
                <Copy size={11} className="opacity-40 hover:opacity-100" />
              )}
            </button>
          </div>
          
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDelete(task.id);
            }}
            type="button"
            className="opacity-0 group-hover:opacity-100 text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-[#fff0ed] dark:hover:bg-[#292119] transition-all cursor-pointer duration-150"
            title="Remove card"
          >
            <Trash2 size={13} />
          </button>
        </div>

        {/* Agent & Model Metadata Badge - placed right under priority */}
        {task.agent && task.model && (
          <div className="flex flex-wrap items-center gap-1.5 mb-2.5 px-0.5 select-none font-mono font-bold">
            <span className="flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-[#fae8ff] dark:bg-[#292119] text-[#86198f] dark:text-[#f3eadf] border border-[#f5d0fe] dark:border-[#584a3b] text-[8px]">
              🤖 {task.model}
            </span>
            {task.effort && (
              <span className="px-1.5 py-0.5 rounded-md bg-[#f1f5f9] dark:bg-[#292119] text-[#475569] dark:text-[#f3eadf] border border-[#e2e8f0] dark:border-[#584a3b] text-[8px]">
                ⚡ {task.effort.toUpperCase()} EFFORT
              </span>
            )}
          </div>
        )}

        {/* Title text */}
        <h3 className={`text-xs leading-relaxed mb-3.5 font-sans line-clamp-2 pl-0.5 select-text selection:bg-[#ffd9aa] dark:bg-[#292119] select-none ${
          isDone ? 'text-gray-400 dark:text-[#b8ab9f] line-through font-normal' : 'text-[#3e3129] dark:text-[#f3eadf] font-extrabold'
        }`}>
          {task.title}
        </h3>

        {/* Card Thumbnail Preview (if design image is attached) */}
        {((task.designImages && task.designImages.length > 0) || task.designImage) && (
          <div className="relative mb-3 rounded-xl overflow-hidden border border-[#ebdcb9] dark:border-[#584a3b] h-14 bg-white dark:bg-[#292119]/50 pl-0.5">
            <img 
              src={(task.designImages && task.designImages[0]) || task.designImage} 
              alt="Design Preview" 
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200" 
              referrerPolicy="no-referrer"
            />
            {task.designImages && task.designImages.length > 1 && (
              <div className="absolute top-1 right-1 bg-black/60 backdrop-blur-md text-white dark:text-[#f3eadf] text-[9px] font-bold px-1.5 py-0.5 rounded shadow-sm border border-white">
                +{task.designImages.length - 1}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Structured files/checklist progress details */}
      {(filesCount > 0 || totalSteps > 0) && (
        <div className="flex flex-wrap items-center gap-2 mb-3.5 px-0.5 text-[9.5px] font-mono text-[#7a6455] dark:text-[#f3eadf]">
          {filesCount > 0 && (
            <span className="flex items-center gap-1 bg-[#ede6dc]/30 dark:bg-[#292119]/30 border border-[#e8dfcf] dark:border-[#584a3b] px-2 py-0.5 rounded-lg font-bold">
              📁 {filesCount} {filesCount === 1 ? 'file' : 'files'}
            </span>
          )}
          {totalSteps > 0 && (
            <span className={`flex items-center gap-1 border px-2 py-0.5 rounded-lg font-bold ${
              completedSteps === totalSteps 
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200/60' 
                : 'bg-[#fffcf4] dark:bg-[#292119] text-[#a47a32] dark:text-[#f3eadf] border-[#f0e3cc] dark:border-[#584a3b]'
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
            <span className="flex items-center gap-1 bg-[#fff2e0] dark:bg-[#292119] text-[#9a6428] dark:text-[#f3eadf] border border-[#fde5bd] dark:border-[#584a3b] px-1.5 py-0.5 rounded-lg">
              <ImageIcon size={10} /> Design Doc {task.designImages && task.designImages.length > 1 && `(${task.designImages.length})`}
            </span>
          )}
          {task.specUrl && (
            <span className="flex items-center gap-1 bg-[#e0f1f7] dark:bg-[#292119] text-[#2c6e85] dark:text-[#f3eadf] border border-[#cbe4ee] dark:border-[#584a3b] px-1.5 py-0.5 rounded-lg">
              <LinkIcon size={10} /> Spec Link
            </span>
          )}
        </div>
      )}

      {/* Lock badge - shown when an agent is actively working */}
      {task.activeAgent && (
        <div className="mb-2 mx-0.5 flex items-center gap-1 text-[10px] font-mono font-extrabold px-2 py-1.5 rounded-xl bg-orange-50 text-orange-700 border border-orange-200 select-none">
          <Lock size={10} className="shrink-0" />
          Locked by {task.activeAgent}
        </div>
      )}

      {/* Actions: Git Branch Copy Trigger and Starting Template */}
      <div className="flex gap-1.5 mb-3 mx-0.5">
        {task.branch && (
          <div 
            onClick={handleCopyBranch}
            className={`group/branch flex-1 min-w-0 p-2 rounded-xl border flex items-center justify-between text-[10px] font-mono font-medium cursor-pointer transition-all active:scale-[0.98] ${
              isDone 
                ? 'bg-[#f8f5ee] dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] text-gray-400 dark:text-[#b8ab9f] border-dashed hover:border-gray-400'
                : isInProgress
                  ? 'bg-[#fff9e6] dark:bg-[#292119] border-[#fde5bd] dark:border-[#584a3b] text-[#935919] dark:text-[#e0a070] hover:bg-[#fff5d3] dark:hover:bg-[#292119] hover:border-[#fbc58e] dark:hover:border-[#584a3b]'
                  : 'bg-[#faf7f0] dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] text-[#715c4d] dark:text-[#f3eadf] hover:bg-[#fff9e6] dark:hover:bg-[#292119] hover:border-[#fde5bd] dark:hover:border-[#584a3b]'
            }`}
            title="Click to copy Git Branch instruction"
          >
            <div className="flex items-center gap-1.5 truncate">
              <GitBranch size={11} className={`${isDone ? 'text-emerald-500' : 'text-[#d89745] dark:text-[#e0a070]'} shrink-0 group-hover/branch:rotate-12 transition-transform`} />
              <span className="truncate">{task.branch}</span>
            </div>
            <button
              type="button"
              className="text-gray-400 dark:text-[#b8ab9f] group-hover/branch:text-[#d89745] dark:text-[#e0a070] shrink-0 transition-colors ml-2"
            >
              {copied ? (
                <Check size={11} className="text-emerald-500 animate-scale" />
              ) : (
                <Copy size={11} />
              )}
            </button>
          </div>
        )}
        <div className={task.branch ? 'flex-none' : 'w-full'}>
          <CopyTemplateButton task={task} className={`h-full ${task.branch ? 'px-3' : 'w-full justify-center py-1.5'}`} variant={task.branch ? 'icon' : 'full'} />
        </div>
      </div>

      {/* Subtasks compact section */}
      {subtasks && subtasks.length > 0 && (
        <div className="mt-2.5 mb-2.5 p-2 bg-[#fdfbf8]/90 dark:bg-[#292119]/90 border border-[#ede3d2] dark:border-[#584a3b] rounded-xl flex flex-col gap-1.5" onClick={(e) => e.stopPropagation()}>
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
                  className={`group/sub flex flex-col gap-1 p-1.5 rounded-xl border text-[10px] cursor-grab active:cursor-grabbing transition-all hover:bg-white dark:hover:bg-[#1e1914] select-none ${
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
                      className={`w-3.5 h-3.5 rounded flex items-center justify-center border transition-all cursor-pointer ${
                        subDone 
                          ? 'bg-emerald-500 border-emerald-500 text-white dark:text-[#f3eadf]' 
                          : 'bg-white dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] hover:border-[#d4994e] dark:hover:border-[#584a3b]'
                      }`}
                    >
                      {subDone && <span className="text-[8px] leading-none mb-0.5">✓</span>}
                    </button>
                    <span className={`truncate flex-1 hover:underline text-[9.5px] font-sans ${subDone ? 'line-through' : ''}`}>{sub.title}</span>
                  </div>
                  
                  {/* Small statuses/agent info */}
                  <div className="flex items-center gap-1 shrink-0 font-mono text-[7.5px] font-bold ml-[19px]">
                    {sub.model && (
                      <span className="px-1 py-0.2 rounded border bg-[#fae8ff] dark:bg-[#292119] text-[#86198f] dark:text-[#f3eadf] border-[#f5d0fe] dark:border-[#584a3b]">
                        {sub.model}
                      </span>
                    )}
                    <span className={`px-1 py-0.2 rounded uppercase border ${
                      subDone ? 'bg-emerald-50 text-emerald-700 border-emerald-200/40' :
                      subInProgress ? 'bg-orange-50 text-orange-700 border-orange-200/40' :
                      sub.status === 'todo' ? 'bg-[#fffdf4] dark:bg-[#292119] text-[#a47a32] dark:text-[#f3eadf] border-[#f0e3cc] dark:border-[#584a3b]' :
                      'bg-gray-50 dark:bg-[#292119] text-gray-400 dark:text-[#b8ab9f] border-gray-200'
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
      <div className="flex flex-col gap-2 mt-2 pt-2 border-t border-[#f2ece2] dark:border-[#584a3b]" onClick={(e) => e.stopPropagation()}>
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
              className="w-full bg-[#fdfbf7] dark:bg-[#292119] hover:bg-white dark:hover:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] hover:border-[#d4994e] dark:hover:border-[#584a3b] rounded-xl text-[9px] py-1 px-1.5 focus:border-[#d4994e] dark:focus:border-[#584a3b] outline-none text-[#564436] dark:text-[#f3eadf] font-sans font-bold transition-all cursor-pointer truncate"
            >
              <option value="">👤 Unassigned</option>
              <option value="Codex">🤖 Codex</option>
              <option value="Antigravity">🤖 Antigravity</option>
              <option value="Claude">🤖 Claude</option>
            </select>
          </div>

          {/* Model Selector - only show if agent is assigned */}
          {task.agent && (
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
                className="w-full bg-[#fdfbf7] dark:bg-[#292119] hover:bg-white dark:hover:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] hover:border-[#d4994e] dark:hover:border-[#584a3b] rounded-xl text-[9px] py-1 px-1.5 focus:border-[#d4994e] dark:focus:border-[#584a3b] outline-none text-[#564436] dark:text-[#f3eadf] font-sans font-bold transition-all cursor-pointer truncate disabled:opacity-50"
              >
                <option value="">⚡ Default Model</option>
                {AGENTS_CONFIG[task.agent as import('../lib/agentsConfig').AgentName]?.map(m => (
                  <option key={m.model_name} value={m.model_name}>
                    {m.model_name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Footer Metrics */}
        <div className="flex items-center justify-between pt-0.5 select-none text-[9px] font-mono">
          <span className="text-[#a59082] dark:text-[#d6b56d] italic">
            {task.branch ? 'git checkouts configured' : 'no active branch'}
          </span>
          <div className="flex items-center gap-2 font-mono shrink-0">
            <span className="text-[#9e8b7c] dark:text-[#d6b56d] font-bold" title="Last updated">
              {isDone ? '✓ merged' : formattedDate}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
