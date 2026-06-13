/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { X, GitBranch, PlusSquare, FileCode, CheckSquare, Sparkles, Image as ImageIcon, Link as LinkIcon } from 'lucide-react';
import { Task, TaskPriority, TaskStatus, ChecklistItem } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';

interface CreateTaskModalProps {
  onClose: () => void;
  onSubmit: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => void;
  parentId?: string;
  parentTitle?: string;
}

export default function CreateTaskModal({ onClose, onSubmit, parentId, parentTitle }: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [status, setStatus] = useState<TaskStatus>('backlog');
  const [filesInput, setFilesInput] = useState('');
  const [checklistInput, setChecklistInput] = useState('');
  const [designImages, setDesignImages] = useState<string[]>([]);
  const [specUrl, setSpecUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');

  const injectTemplate = () => {
    const template = `### Objective
Describe the mobile development goal here.

### Architecture Guideline
Identify patterns (e.g. MVVM ViewModel, Repository boundary, Compose/SwiftUI reactive states).

### Code Reference
\`\`\`kotlin
// Write Kotlin/Swift snippets to help the AI Agent
class MyViewModel: ViewModel() { 
    // State management
}
\`\`\``;
    setDescription(template);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    const tagsArray: string[] = [];

    const filesArray = filesInput
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0);

    const checklistLines = checklistInput
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const parsedChecklist: ChecklistItem[] = checklistLines.map((line, idx) => ({
      id: `step-${Date.now()}-${idx}`,
      text: line,
      completed: false
    }));

    onSubmit({
      title: title.trim(),
      description: description.trim(),
      status,
      branch: branch.trim() || undefined,
      priority,
      tags: tagsArray,
      targetFiles: filesArray,
      checklist: parsedChecklist,
      designImages: designImages.length > 0 ? designImages : undefined,
      specUrl: specUrl.trim() || undefined,
      agent: agent || '',
      model: model || '',
      effort: effort || '',
      parentId: parentId || undefined
    });
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      {/* Outer Close clicking */}
      <div className="fixed inset-0" onClick={onClose} />

      {/* Modal Card */}
      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-xl rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col justify-between font-sans">
        
        {/* Header toolbar */}
        <div className="p-5 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between font-mono text-[#5c493c] dark:text-[#f3eadf]">
          <div className="flex items-center gap-2">
            <Sparkles size={18} className="text-[#bf8a50] dark:text-[#d6b56d]" />
            <div>
              <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase">
                {parentId ? 'CREATE_SUBTASK_SPEC' : 'INIT_NEW_SPEC_TICKET'}
              </h2>
              {parentTitle && (
                <p className="text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] mt-0.5 truncate max-w-[320px] font-bold font-sans">
                  Parent: #{parentId} • {parentTitle}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1.5 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
          >
            <X size={17} />
          </button>
        </div>

        {/* Input fields Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 max-h-[75vh] overflow-y-auto scrollbar-thin text-xs font-mono text-[#5c493c] dark:text-[#f3eadf]">
          
          {/* Main Title input */}
          <div className="space-y-1">
            <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
              Task Name / Ticket Title
            </label>
            <input
              type="text"
              required
              autoFocus
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 text-xs text-[#3a2f26] dark:text-[#f3eadf] placeholder-[#c4b3a4] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans"
              placeholder="e.g., Setup ViewModel and StateFlow cache in Kotlin"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          {/* Inline grid branch & tag info */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
                <GitBranch size={11} className="text-[#b87332] dark:text-[#f3eadf]" /> Git Checkout Branch
              </label>
              <input
                type="text"
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 text-xs text-[#9d5b12] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b]"
                placeholder="feature/swiftui-charts"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                Target Column Status
              </label>
              <select
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b]"
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
              >
                <option value="backlog">Backlog Lane</option>
                <option value="todo">To Do Lane</option>
                <option value="in-progress">In Progress Lane</option>
                <option value="ready-for-review">Ready for Review Lane</option>
                <option value="done">Done Lane</option>
              </select>
            </div>
          </div>

          <div className="space-y-1">
            <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
              Severity Rating
            </label>
            <select
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b]"
              value={priority}
              onChange={(e) => setPriority(e.target.value as TaskPriority)}
            >
              <option value="low">Low Severity</option>
              <option value="medium">Medium Severity</option>
              <option value="high">High Severity</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                Assigned Agent
              </label>
              <select
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-bold"
                value={agent}
                onChange={(e) => {
                  const val = e.target.value;
                  setAgent(val);
                  if (val) {
                    const defaultModel = defaultModelForAgent(val);
                    setModel(defaultModel);
                    setEffort(defaultEffortForModel(val, defaultModel));
                  } else {
                    setModel('');
                    setEffort('');
                  }
                }}
              >
                <option value="">Unassigned</option>
                <option value="Codex">Codex</option>
                <option value="Antigravity">Antigravity</option>
                <option value="Claude">Claude</option>
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                AI Model Spec
              </label>
              <select
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-bold disabled:bg-[#f5eeda] dark:bg-[#1e1914]/50 dark:disabled:bg-[#292119]/50"
                value={model}
                disabled={!agent}
                onChange={(e) => {
                  const val = e.target.value;
                  setModel(val);
                  if (agent && val) {
                    setEffort(defaultEffortForModel(agent, val));
                  } else {
                    setEffort('');
                  }
                }}
              >
                <option value="">None / Default</option>
                {agent && AGENTS_CONFIG[agent as import('../lib/agentsConfig').AgentName]?.map(m => (
                  <option key={m.model_name} value={m.model_name}>
                    {m.model_name}
                  </option>
                ))}
              </select>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                Effort Allocation
              </label>
              <select
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-bold disabled:bg-[#f5eeda] dark:bg-[#1e1914]/50 dark:disabled:bg-[#292119]/50"
                value={effort}
                disabled={!agent || !model}
                onChange={(e) => setEffort(e.target.value)}
              >
                {agent && model && getModelConfig(agent, model)?.available_efforts.map(eff => (
                  <option key={eff} value={eff}>
                    {eff.charAt(0).toUpperCase() + eff.slice(1)}
                  </option>
                ))}
              </select>
            </div>
          </div>



          {/* New target files text input area */}
          <div className="space-y-1">
            <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
              <FileCode size={12} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Target Files to Edit (One path per line)
            </label>
            <textarea
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 h-20 outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono resize-y text-[#3a2f26] dark:text-[#f3eadf]"
              placeholder="e.g.&#10;app/src/main/java/com/example/MainActivity.kt&#10;ios/Views/HomeView.swift"
              value={filesInput}
              onChange={(e) => setFilesInput(e.target.value)}
            />
          </div>

          {/* New checklist steps text input area */}
          <div className="space-y-1">
            <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
              <CheckSquare size={12} className="text-[#728f44] dark:text-[#f3eadf]" /> Implementation Steps (One task per line)
            </label>
            <textarea
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 h-20 outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono resize-y text-[#3a2f26] dark:text-[#f3eadf]"
              placeholder="e.g.&#10;Configure Room Entities and Dao database mappings&#10;Add dynamic Material-You dynamic colors support"
              value={checklistInput}
              onChange={(e) => setChecklistInput(e.target.value)}
            />
          </div>

          {/* Design Image & Spec URL Section */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-b border-[#ebdcb9]/45 dark:border-[#584a3b]/45 py-3 font-sans">
            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] font-mono uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
                <ImageIcon size={12} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Design Image (File or URL)
              </label>
              <div className="space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <label className={`text-[10px] bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1.5 rounded-lg text-[#5c493c] dark:text-[#f3eadf] hover:bg-[#fffcf6] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] cursor-pointer inline-flex items-center gap-1 font-bold ${designImages.length >= 5 ? 'opacity-50 cursor-not-allowed' : ''}`}>
                    <span>Upload Image(s) {designImages.length > 0 && `(${designImages.length}/5)`}</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      disabled={designImages.length >= 5}
                      className="hidden"
                      onChange={(e) => {
                        const files = Array.from(e.target.files || []);
                        const availableSlots = 5 - designImages.length;
                        const filesToProcess = files.slice(0, availableSlots);
                        
                        filesToProcess.forEach(file => {
                          const reader = new FileReader();
                          reader.onloadend = () => {
                            if (typeof reader.result === 'string') {
                              setDesignImages(prev => [...prev, reader.result as string]);
                            }
                          };
                          reader.readAsDataURL(file);
                        });
                      }}
                    />
                  </label>
                  {designImages.length > 0 && (
                    <button
                      type="button"
                      onClick={() => setDesignImages([])}
                      className="text-[10px] text-red-500 font-bold hover:underline cursor-pointer"
                    >
                      Clear All
                    </button>
                  )}
                </div>
                {designImages.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto pb-1 mt-2">
                    {designImages.map((img, idx) => (
                      <div key={idx} className="relative border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg overflow-hidden h-14 w-14 shrink-0 bg-white dark:bg-[#1e1914] group">
                        <img src={img} alt={`Preview ${idx + 1}`} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                        <button 
                          type="button"
                          onClick={() => setDesignImages(prev => prev.filter((_, i) => i !== idx))}
                          className="absolute top-0 right-0 bg-red-500 text-white dark:text-[#f3eadf] w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] font-mono uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
                <LinkIcon size={12} className="text-[#3c829e] dark:text-[#f3eadf]" /> Specification link / URL
              </label>
              <input
                type="text"
                className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-2.5 py-2 text-[11px] text-[#3a2f26] dark:text-[#f3eadf] placeholder-[#c4b3a4] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans"
                placeholder="e.g. Figma link or API Doc URL"
                value={specUrl}
                onChange={(e) => setSpecUrl(e.target.value)}
              />
              <p className="text-[9px] text-[#8c7463] dark:text-[#f3eadf] font-mono pl-0.5 leading-relaxed">Link to external product design, spreadsheet, or spec sheet.</p>
            </div>
          </div>

          {/* Spec details markdown */}
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="block text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold pl-0.5">
                Detailed Specs & Guidelines (Markdown)
              </label>
              <button
                type="button"
                onClick={injectTemplate}
                className="text-[9px] bg-[#fffbf4] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] text-[#b47320] dark:text-[#f3eadf] hover:bg-[#fff9ed] dark:hover:bg-[#1e1914] px-2.5 py-1 rounded-lg transition-colors cursor-pointer font-extrabold shadow-3xs"
              >
                + Inject Code Template
              </button>
            </div>
            <textarea
              className="w-full bg-white dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2.5 h-24 outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] resize-y text-[#3a2f26] dark:text-[#f3eadf]"
              placeholder="Supply code scripts or markdown blueprint notes..."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Buttons bar */}
          <div className="flex gap-3 pt-4 border-t border-[#ebdcb9] dark:border-[#584a3b]">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] text-[#816b5a] dark:text-[#f3eadf] bg-white dark:bg-[#1e1914] hover:bg-[#fffcf6] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] transition-colors text-xs font-extrabold cursor-pointer transition-all"
            >
              Discard
            </button>
            <button
              type="submit"
              className="flex-1 bg-[#d89745] dark:bg-[#e0a070] hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] font-extrabold py-2.5 rounded-xl text-xs transition-colors shadow-md hover:shadow-orange-550/10 cursor-pointer transition-all"
            >
              Commit Ticket ✨
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
