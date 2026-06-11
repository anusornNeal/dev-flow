/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from 'react';
import { 
  X, 
  Trash2, 
  GitBranch, 
  AlignLeft, 
  Edit3, 
  BookOpen, 
  Activity, 
  Plus, 
  Tag, 
  Database,
  Clock,
  CheckSquare,
  FileCode,
  Check,
  Cat,
  PawPrint,
  Copy,
  Image as ImageIcon,
  Link as LinkIcon
} from 'lucide-react';
import { Task, TaskPriority, TaskStatus, LogEntry, ChecklistItem } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';
import MarkdownRenderer from './MarkdownRenderer';
import CreateTaskModal from './CreateTaskModal';

interface TaskDetailsDrawerProps {
  task: Task;
  allTasks?: Task[];
  onSelectTask?: (task: Task) => void;
  onClose: () => void;
  onUpdate: (updatedTask: Task) => void;
  onDelete: (id: string) => void;
  onCreateTask?: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => Promise<void>;
}

export default function TaskDetailsDrawer({ 
  task, 
  allTasks = [], 
  onSelectTask, 
  onClose, 
  onUpdate, 
  onDelete,
  onCreateTask
}: TaskDetailsDrawerProps) {
  const parentTask = task.parentId ? allTasks.find(t => t.id === task.parentId) : undefined;
  const subTasks = allTasks.filter(t => t.parentId === task.id);
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedDesc, setEditedDesc] = useState(task.description);
  const [editedBranch, setEditedBranch] = useState(task.branch || '');
  const [editedPriority, setEditedPriority] = useState<TaskPriority>(task.priority);
  const [editedStatus, setEditedStatus] = useState<TaskStatus>(task.status);
  const [editedTags, setEditedTags] = useState(task.tags.join(', '));
  
  // New properties editing states
  const [editedFilesStr, setEditedFilesStr] = useState((task.targetFiles || []).join('\n'));
  const [editedChecklistStr, setEditedChecklistStr] = useState((task.checklist || []).map(c => c.text).join('\n'));
  const [editedDesignImages, setEditedDesignImages] = useState<string[]>(task.designImages || (task.designImage ? [task.designImage] : []));
  const [editedSpecUrl, setEditedSpecUrl] = useState(task.specUrl || '');
  
  const handleViewImage = (e: React.MouseEvent, imageUrl: string) => {
    e.preventDefault();
    if (imageUrl.startsWith('data:')) {
      const newTab = window.open();
      if (newTab) {
        newTab.document.write(`
          <html>
            <body style="margin:0;display:flex;justify-content:center;align-items:center;background:#0e0e0e;min-height:100vh;">
              <img src="${imageUrl}" style="max-width:100%;max-height:100vh;" />
            </body>
          </html>
        `);
        newTab.document.close();
      }
    } else {
      window.open(imageUrl, '_blank');
    }
  };
  const [editedAgent, setEditedAgent] = useState(task.agent || '');
  const [editedModel, setEditedModel] = useState(task.model || '');
  const [editedEffort, setEditedEffort] = useState(task.effort || '');
  const [editedReasoning, setEditedReasoning] = useState(task.reasoning || '');
  const [editedAcceptance, setEditedAcceptance] = useState(task.acceptanceCriteria || '');
  const [editedVerification, setEditedVerification] = useState(task.verification || '');
  const [editedRepoContext, setEditedRepoContext] = useState(task.repoContext || '');
  const [editedJiraKey, setEditedJiraKey] = useState(task.jiraKey || '');
  const [editedRepo, setEditedRepo] = useState(task.repo || '');
  const [editedSourceUrl, setEditedSourceUrl] = useState(task.sourceUrl || '');
  
  const [newComment, setNewComment] = useState('');
  const [copied, setCopied] = useState(false);
  const [idCopied, setIdCopied] = useState(false);
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);

  // Sync state with task changes
  useEffect(() => {
    if (!isEditing) {
      setEditedTitle(task.title);
      setEditedDesc(task.description);
      setEditedBranch(task.branch || '');
      setEditedPriority(task.priority);
      setEditedStatus(task.status);
      setEditedTags(task.tags.join(', '));
      setEditedFilesStr((task.targetFiles || []).join('\n'));
      setEditedChecklistStr((task.checklist || []).map(c => c.text).join('\n'));
      setEditedDesignImages(task.designImages || (task.designImage ? [task.designImage] : []));
      setEditedSpecUrl(task.specUrl || '');
      setEditedAgent(task.agent || '');
      setEditedModel(task.model || '');
      setEditedEffort(task.effort || '');
    }
  }, [task, isEditing]);

  const handleSave = () => {
    if (!editedTitle.trim()) return;

    const tagsArray: string[] = [];

    const filesArray = editedFilesStr
      .split('\n')
      .map(f => f.trim())
      .filter(f => f.length > 0);

    const checklistLines = editedChecklistStr
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    const parsedChecklist: ChecklistItem[] = checklistLines.map((line, idx) => {
      const existing = (task.checklist || []).find(c => c.text === line);
      return {
        id: existing?.id || `step-${Date.now()}-${idx}`,
        text: line,
        completed: existing?.completed || false
      };
    });

    // Track historical changes in logs
    const newLogs: LogEntry[] = [...task.logs];
    
    if (editedStatus !== task.status) {
      newLogs.push({
        id: `log-${Date.now()}-status`,
        timestamp: new Date().toISOString(),
        message: `Status moved from ${task.status.toUpperCase()} to ${editedStatus.toUpperCase()}`,
        type: 'move'
      });
    }

    if (editedBranch !== (task.branch || '')) {
      newLogs.push({
        id: `log-${Date.now()}-branch`,
        timestamp: new Date().toISOString(),
        message: editedBranch 
          ? `Branch checkout updated to: ${editedBranch}` 
          : 'Removed active git branch',
        type: 'edit'
      });
    }

    const updatedTask: Task = {
      ...task,
      title: editedTitle,
      description: editedDesc,
      branch: editedBranch.trim(),
      priority: editedPriority,
      status: editedStatus,
      tags: tagsArray,
      targetFiles: filesArray,
      checklist: parsedChecklist,
      designImages: editedDesignImages.length > 0 ? editedDesignImages : undefined,
      specUrl: editedSpecUrl.trim() || undefined,
      agent: editedAgent || '',
      model: editedModel || '',
      effort: editedEffort || '',
      reasoning: editedReasoning || undefined,
      acceptanceCriteria: editedAcceptance || undefined,
      verification: editedVerification || undefined,
      repoContext: editedRepoContext || undefined,
      jiraKey: editedJiraKey || undefined,
      repo: editedRepo || undefined,
      sourceUrl: editedSourceUrl || undefined,
      updatedAt: new Date().toISOString(),
      logs: newLogs
    };

    onUpdate(updatedTask);
    setIsEditing(false);
  };

  const handleToggleChecklistItem = (itemIdentifier: string) => {
    const updatedChecklist = (task.checklist || []).map(item => {
      const currentIdentifier = item.id || item.text;
      if (currentIdentifier === itemIdentifier) {
        const nextState = !item.completed;
        return { ...item, completed: nextState };
      }
      return item;
    });

    const toggledItemText = (task.checklist || []).find(item => (item.id || item.text) === itemIdentifier)?.text || '';
    const wasCompleted = (task.checklist || []).find(item => (item.id || item.text) === itemIdentifier)?.completed || false;

    const newLogItem: LogEntry = {
      id: `log-cl-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `✓ Checklist item "${toggledItemText}" toggled to ${!wasCompleted ? 'COMPLETED' : 'INCOMPLETE'}`,
      type: 'edit'
    };

    const updatedTask: Task = {
      ...task,
      checklist: updatedChecklist,
      logs: [...task.logs, newLogItem],
      updatedAt: new Date().toISOString()
    };

    onUpdate(updatedTask);
  };

  const handleAddComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;

    const newLogItem: LogEntry = {
      id: `log-comment-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `💬 Note: ${newComment}`,
      type: 'comment'
    };

    const updatedTask: Task = {
      ...task,
      logs: [...task.logs, newLogItem],
      updatedAt: new Date().toISOString()
    };

    onUpdate(updatedTask);
    setNewComment('');
  };

  const handleCopyCommand = () => {
    if (!task.branch) return;
    navigator.clipboard.writeText(`git checkout -b ${task.branch}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyId = () => {
    const idToCopy = task.displayId || task.id;
    if (!idToCopy) return;
    navigator.clipboard.writeText(idToCopy);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      {/* Backdrop click-away */}
      <div className="fixed inset-0" onClick={onClose} />

      {/* Centered Spec Sheet Modal Container */}
      <div className="bg-[#fcf9f4] border border-[#ebdcb9] w-full max-w-2xl h-[85vh] rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col justify-between font-sans">
        
        {/* Custom Header bar */}
        <div className="p-5 border-b border-[#ebdcb9] bg-[#ebdcb9]/40 flex items-center justify-between font-mono text-[#5c493c]">
          <div className="flex items-center gap-2">
            <button 
              type="button"
              onClick={handleCopyId}
              className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-[#8a6e5a] hover:text-[#d89745] bg-[#fffbf4] hover:bg-[#ebdcb9]/30 px-2.5 py-1 rounded-xl border border-[#ebdcb9] transition-colors cursor-pointer"
              title="Copy Card ID"
            >
              ID: {task.displayId || task.id}
              {idCopied ? (
                <Check size={11} className="text-emerald-500" />
              ) : (
                <Copy size={11} className="opacity-40 hover:opacity-100" />
              )}
            </button>
            <span className="h-4 w-px bg-[#ebdcb9]" />
            <span className="text-[10px] text-[#8a6e5a] font-semibold">
              Updated at {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className="text-[11px] font-mono bg-[#fffbf4] border border-[#ebdcb9] text-[#6e5340] hover:bg-[#fff9ed] px-3 py-1.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow-2xs mr-1"
            >
              {isEditing ? (
                <>
                  <BookOpen size={13} className="text-[#38b000]" />
                  <span className="font-bold">Preview Spec</span>
                </>
              ) : (
                <>
                  <Edit3 size={13} className="text-[#e5a93b]" />
                  <span className="font-bold">Edit Spec</span>
                </>
              )}
            </button>
            <button
              onClick={() => onDelete(task.id)}
              type="button"
              className="text-[#9e8b7e] hover:text-red-500 p-2 rounded-full hover:bg-white/60 transition-all cursor-pointer"
              title="Delete ticket"
            >
              <Trash2 size={16} />
            </button>
            <button
              onClick={onClose}
              type="button"
              className="text-[#9e8b7e] hover:text-[#5c493c] p-2 rounded-full hover:bg-white/60 transition-all cursor-pointer"
              title="Close panel"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* Scrollable spec sheets details */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 scrollbar-thin">
          
          {/* Parent Context Banner */}
          {parentTask && (
            <div className="bg-[#f2ece5]/80 border border-[#d6cbbe] rounded-2xl p-4.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 font-sans select-none animate-fade-in shadow-xs">
              <div className="space-y-1">
                <span className="text-[10px] font-mono uppercase bg-[#ffffff] text-[#8c7463] px-2 py-0.5 rounded-lg border border-[#ebdcb9] font-extrabold">
                  🌿 Linked Subtask Spec
                </span>
                <h4 className="text-xs font-black text-[#5c493c] leading-snug line-clamp-1 mt-1 font-sans">
                  Parent: #{parentTask.displayId || parentTask.id} • {parentTask.title}
                </h4>
                <p className="text-[10.5px] text-[#8c7463] font-sans">
                  This task constitutes a nested modular checkpoint of its parent workspace ticket.
                </p>
              </div>
              {onSelectTask && (
                <button
                  type="button"
                  onClick={() => onSelectTask(parentTask)}
                  className="bg-white hover:bg-[#fff9ed] border border-[#ebdcb9] hover:border-[#d4994e] text-[#6e5340] font-extrabold px-3 py-1.5 rounded-xl text-[10.5px] flex items-center gap-1.5 transition-all shadow-4xs cursor-pointer hover:shadow-2xs active:scale-[0.98] shrink-0"
                >
                  <Cat size={12} className="text-[#d89745]" /> Open Parent Card
                </button>
              )}
            </div>
          )}

          {isEditing ? (
            /* ================= EDIT MODE SPECIFICATION ================= */
            <div className="space-y-4 text-xs font-mono text-[#5c493c]">
              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Issue Title</label>
                <input
                  type="text"
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] font-sans transition-all"
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Lane Status</label>
                  <select
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all"
                    value={editedStatus}
                    onChange={(e) => setEditedStatus(e.target.value as TaskStatus)}
                  >
                    <option value="backlog">Backlog Lane</option>
                    <option value="todo">To Do Lane</option>
                    <option value="in-progress">In Progress Lane</option>
                    <option value="ready-for-review">Ready for Review Lane</option>
                    <option value="done">Done Lane</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Urgency Level</label>
                  <select
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all"
                    value={editedPriority}
                    onChange={(e) => setEditedPriority(e.target.value as TaskPriority)}
                  >
                    <option value="low">Low Severity</option>
                    <option value="medium">Medium Severity</option>
                    <option value="high">High Severity</option>
                  </select>
                </div>
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Checkout Branch</label>
                <input
                  type="text"
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#b87332] outline-none focus:border-[#d7933f] transition-all"
                  placeholder="feature/compose-ui-locks"
                  value={editedBranch}
                  onChange={(e) => setEditedBranch(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Assigned Agent</label>
                  <select
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-bold"
                    value={editedAgent}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditedAgent(val);
                      if (val) {
                        const defaultModel = defaultModelForAgent(val);
                        setEditedModel(defaultModel);
                        setEditedEffort(defaultEffortForModel(val, defaultModel));
                      } else {
                        setEditedModel('');
                        setEditedEffort('');
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
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">AI Model Spec</label>
                  <select
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-bold disabled:bg-[#f5eeda]/50"
                    value={editedModel}
                    disabled={!editedAgent}
                    onChange={(e) => {
                      const val = e.target.value;
                      setEditedModel(val);
                      if (editedAgent && val) {
                        setEditedEffort(defaultEffortForModel(editedAgent, val));
                      } else {
                        setEditedEffort('');
                      }
                    }}
                  >
                    <option value="">None / Default</option>
                    {editedAgent && AGENTS_CONFIG[editedAgent as import('../lib/agentsConfig').AgentName]?.map(m => (
                      <option key={m.model_name} value={m.model_name}>
                        {m.model_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold">Effort Allocation</label>
                  <select
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-bold disabled:bg-[#f5eeda]/50"
                    value={editedEffort}
                    disabled={!editedAgent || !editedModel}
                    onChange={(e) => setEditedEffort(e.target.value)}
                  >
                    {editedAgent && editedModel && getModelConfig(editedAgent, editedModel)?.available_efforts.map(eff => (
                      <option key={eff} value={eff}>
                        {eff.charAt(0).toUpperCase() + eff.slice(1)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>



              {/* Path Editor box */}
              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Target Files to Modify</span>
                  <span className="text-[9px] text-[#9c8473] lowercase font-normal">(one relative file path per line)</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-24 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  placeholder="app/src/main/java/com/example/MainActivity.kt"
                  value={editedFilesStr}
                  onChange={(e) => setEditedFilesStr(e.target.value)}
                />
              </div>

              {/* Action checklist lines */}
              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Implementation Checklist Steps</span>
                  <span className="text-[9px] text-[#9c8473] lowercase font-normal">(one task step per line)</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-24 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  value={editedChecklistStr}
                  onChange={(e) => setEditedChecklistStr(e.target.value)}
                />
              </div>

              {/* Design Image & Spec URL Section */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-b border-[#ebdcb9]/45 py-3 font-sans">
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] font-mono uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
                    <ImageIcon size={12} className="text-[#bf8a50]" /> Design Image (File or URL)
                  </label>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <label className={`text-[10px] bg-white border border-[#ebdcb9] px-2.5 py-1.5 rounded-lg text-[#5c493c] hover:bg-[#fffcf6] cursor-pointer inline-flex items-center gap-1 font-bold ${editedDesignImages.length >= 5 ? 'opacity-50 cursor-not-allowed' : ''}`}>
                        <span>Upload Image(s) {editedDesignImages.length > 0 && `(${editedDesignImages.length}/5)`}</span>
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          disabled={editedDesignImages.length >= 5}
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            const availableSlots = 5 - editedDesignImages.length;
                            const filesToProcess = files.slice(0, availableSlots);
                            
                            filesToProcess.forEach(file => {
                              const reader = new FileReader();
                              reader.onloadend = () => {
                                if (typeof reader.result === 'string') {
                                  setEditedDesignImages(prev => [...prev, reader.result as string]);
                                }
                              };
                              reader.readAsDataURL(file);
                            });
                          }}
                        />
                      </label>
                      {editedDesignImages.length > 0 && (
                        <button
                          type="button"
                          onClick={() => setEditedDesignImages([])}
                          className="text-[10px] text-red-500 font-bold hover:underline cursor-pointer"
                        >
                          Clear All
                        </button>
                      )}
                    </div>
                    {editedDesignImages.length > 0 && (
                      <div className="flex gap-2 overflow-x-auto pb-1 mt-2">
                        {editedDesignImages.map((img, idx) => (
                          <div key={idx} className="relative border border-[#ebdcb9] rounded-lg overflow-hidden h-14 w-14 shrink-0 bg-white group">
                            <img src={img} alt={`Preview ${idx + 1}`} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                            <button 
                              type="button"
                              onClick={() => setEditedDesignImages(prev => prev.filter((_, i) => i !== idx))}
                              className="absolute top-0 right-0 bg-red-500 text-white w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity"
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
                  <label className="block text-[10px] text-[#8a6e5a] font-mono uppercase tracking-widest flex items-center gap-1 font-extrabold pl-0.5">
                    <LinkIcon size={12} className="text-[#3c829e]" /> Specification link / URL
                  </label>
                  <input
                    type="text"
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-2.5 py-2 text-[11px] text-[#3a2f26] placeholder-[#c4b3a4] outline-none focus:border-[#d7933f] font-sans"
                    placeholder="e.g. Figma link or API Doc URL"
                    value={editedSpecUrl}
                    onChange={(e) => setEditedSpecUrl(e.target.value)}
                  />
                  <p className="text-[9px] text-[#8c7463] font-mono pl-0.5 leading-relaxed">Link to external product design, spreadsheet, or spec sheet.</p>
                </div>
              </div>

              {/* Guideline Specifications markup area */}
              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Detailed Specifications & Code (Markdown)</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-32 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  placeholder="Insert architecture blueprint markdown notes..."
                  value={editedDesc}
                  onChange={(e) => setEditedDesc(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Reasoning & Context</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-16 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  value={editedReasoning}
                  onChange={(e) => setEditedReasoning(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Acceptance Criteria</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-16 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  value={editedAcceptance}
                  onChange={(e) => setEditedAcceptance(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Verification Steps</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-16 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  value={editedVerification}
                  onChange={(e) => setEditedVerification(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                  <span>Repository Context</span>
                </label>
                <textarea
                  className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] h-16 outline-none focus:border-[#d7933f] transition-all resize-y font-mono"
                  value={editedRepoContext}
                  onChange={(e) => setEditedRepoContext(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                    <span>Jira Issue Key</span>
                  </label>
                  <input
                    type="text"
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-mono"
                    placeholder="QCA-3314"
                    value={editedJiraKey}
                    onChange={(e) => setEditedJiraKey(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                    <span>Repository URL</span>
                  </label>
                  <input
                    type="text"
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-mono"
                    placeholder="https://github.com/org/repo"
                    value={editedRepo}
                    onChange={(e) => setEditedRepo(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <label className="block text-[10px] text-[#8a6e5a] uppercase tracking-widest font-extrabold flex justify-between">
                    <span>Source URL</span>
                  </label>
                  <input
                    type="text"
                    className="w-full bg-[#ffffff] border border-[#ebdcb9] rounded-xl px-3 py-2 text-xs text-[#3a2f26] outline-none focus:border-[#d7933f] transition-all font-mono"
                    placeholder="https://jira.../browse/..."
                    value={editedSourceUrl}
                    onChange={(e) => setEditedSourceUrl(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-3">
                <button
                  type="button"
                  onClick={() => setIsEditing(false)}
                  className="flex-1 py-2 rounded-xl border border-[#ebdcb9] text-[#6e5a4d] bg-white hover:bg-[#fff9ed] transition-colors text-xs font-bold cursor-pointer"
                >
                  Discard Changes
                </button>
                <button
                  type="button"
                  onClick={handleSave}
                  className="flex-1 bg-[#d89745] hover:bg-[#c08234] text-white font-extrabold py-2 rounded-xl text-xs transition-colors cursor-pointer"
                >
                  Save Modifications
                </button>
              </div>
            </div>
          ) : (
            /* ================= PREVIEW / VIEW MODE ================= */
            <div className="space-y-6 text-[#5c493c]">
              <div>
                <div className="flex items-center gap-1.5 mb-2 text-xs font-mono">
                  <span className={`w-1.5 h-1.5 rounded-full ${
                    task.priority === 'high' ? 'bg-[#de6b48]' : task.priority === 'medium' ? 'bg-[#e5a93b]' : 'bg-[#7dad71]'
                  }`} />
                  <span className="text-[10px] uppercase font-bold tracking-wider text-[#9b8575]">
                    {task.priority || 'low'} Severity level
                  </span>
                </div>
                <h2 className="text-sm font-extrabold text-[#3a2f26] font-sans tracking-tight leading-snug">
                  {task.title}
                </h2>
              </div>

              {/* Status Metadata Panel */}
              <div className="bg-[#fffdfa] p-3.5 rounded-2xl border border-[#ebdcb9] text-xs font-mono flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-2">
                  <Database size={13} className="text-[#bf8a50]" />
                  <span className="text-[10px] uppercase text-[#816c5b] font-bold">Workspace Lane:</span>
                  <span className={`text-[9px] uppercase font-bold px-2 py-0.5 rounded-lg border ${
                    task.status === 'done' ? 'bg-[#e2f0dc] text-[#4d7e35] border-[#bddda4]' :
                    task.status === 'in-progress' ? 'bg-[#ffecca] text-[#a46c24] border-[#f0cca3]' : 
                    'bg-[#f4ebd9]/60 text-[#715c4d] border-[#ebdcb9]'
                  }`}>{task.status}</span>
                </div>
                <div className="text-[9px] text-[#9b8575] font-bold">
                  born {new Date(task.createdAt).toLocaleDateString()}
                </div>
              </div>

              {/* Agent & Model Info Panel */}
              {(task.agent || task.model) && (
                <div className="bg-[#fcfbf9]/70 p-4 rounded-2xl border border-[#ebdcb9] text-xs font-mono flex flex-col gap-3 shadow-xs">
                  <div className="flex flex-wrap gap-4 items-center justify-between">
                    {task.agent && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase text-[#816c5b] font-extrabold">Agent:</span>
                        <span className={`text-[9.5px] uppercase font-bold px-2 py-0.5 rounded-lg border ${
                          task.agent === 'Codex' ? 'bg-[#e0eafc] text-[#1a56db] border-[#bcccf5]' :
                          task.agent === 'Antigravity' ? 'bg-[#fae8ff] text-[#86198f] border-[#f5d0fe]' :
                          'bg-[#fef3c7] text-[#92400e] border-[#fde68a]'
                        }`}>
                          🤖 {task.agent}
                        </span>
                      </div>
                    )}
                    {task.model && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase text-[#816c5b] font-extrabold">Model Spec:</span>
                        <span className="bg-[#f0ece3] text-[#4d3d32] border border-[#d2c9b4] text-[9.5px] font-mono font-bold px-2 py-0.5 rounded-lg">
                          {task.model}
                        </span>
                      </div>
                    )}
                    {task.effort && (
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] uppercase text-[#816c5b] font-extrabold">Effort:</span>
                        <span className="bg-[#f8fafc] text-[#475569] border border-[#e2e8f0] text-[9.5px] font-mono font-bold px-2 py-0.5 rounded-lg uppercase">
                          ⚡ {task.effort}
                        </span>
                      </div>
                    )}
                  </div>


                </div>
              )}

              {/* 🌿 SUBTASKS SECTION */}
              {!task.parentId && (
                <div className="space-y-3.5 border-t border-[#ebdcb9] pt-5 font-sans">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                      <PawPrint size={13} className="text-[#d89745]" /> Subtasks Breakdown ({subTasks.filter(s => s.status === 'done').length}/{subTasks.length})
                    </h4>
                    {onCreateTask && (
                      <button
                        type="button"
                        onClick={() => setIsAddingSubtask(true)}
                        className="bg-[#2a7a8a] text-white hover:bg-[#1a5b67] text-[10px] font-extrabold px-3 py-1.5 rounded-xl flex items-center gap-1 transition-all cursor-pointer shadow-4xs font-sans tracking-wide active:scale-[0.98]"
                      >
                        <Plus size={11} /> Create Subtask Spec
                      </button>
                    )}
                  </div>

                  {subTasks.length > 0 ? (
                    <div className="space-y-2.5">
                      {/* Visual progress bar */}
                      <div className="bg-white border border-[#ebdcb9]/65 p-3 rounded-2xl flex items-center justify-between gap-4 shadow-3xs">
                        <div className="flex-1 bg-[#ede6dc]/60 rounded-full h-1.5 overflow-hidden">
                          <div 
                            className="bg-[#2a7a8a] h-full rounded-full transition-all duration-300"
                            style={{ width: `${(subTasks.filter(s => s.status === 'done').length / subTasks.length) * 100}%` }}
                          />
                        </div>
                        <span className="text-[10px] font-mono font-black text-[#2a7a8a]">
                          {Math.round((subTasks.filter(s => s.status === 'done').length / subTasks.length) * 100)}% complete
                        </span>
                      </div>

                      {/* Scrollable grid list */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 max-h-[220px] overflow-y-auto scrollbar-thin pr-1 select-none">
                        {subTasks.map(sub => {
                          const subDone = sub.status === 'done';
                          const subInProgress = sub.status === 'in-progress';
                          return (
                            <div 
                              key={sub.id}
                              onClick={() => {
                                if (onSelectTask) onSelectTask(sub);
                              }}
                              className={`p-3.5 rounded-2xl border flex flex-col justify-between h-[90px] cursor-pointer transition-all hover:bg-[#fffcf8] active:scale-[0.98] hover:shadow-sm relative ${
                                subDone 
                                  ? 'bg-[#edf7ed]/30 border-emerald-100/50 text-gray-400' 
                                  : subInProgress
                                    ? 'bg-orange-50/15 border-[#e3a35a] shadow-2xs'
                                    : 'bg-white border-[#ebdcb9]/65 text-[#3a2f26]'
                              }`}
                            >
                              <div className="space-y-1 min-w-0 pr-1">
                                <p className={`text-[11px] font-extrabold leading-snug truncate ${subDone ? 'line-through text-gray-400 font-normal' : 'text-[#3e3129]'}`}>
                                  {sub.title}
                                </p>
                                <button 
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    const idToCopy = sub.displayId || sub.id;
                                    navigator.clipboard.writeText(idToCopy);
                                    // A simple visual feedback, though using a dedicated state for subtasks is better, 
                                    // for now we'll just let it copy since it wasn't strictly requested for subtasks, but we'll add the button just in case.
                                  }}
                                  className="flex items-center gap-1 text-[9px] font-mono text-gray-400/80 hover:text-[#d89745] font-bold cursor-pointer"
                                  title="Copy Card ID"
                                >
                                  ID: #{sub.displayId || sub.id}
                                </button>
                              </div>

                              <div className="flex items-center justify-between select-none font-mono text-[7.5px] font-bold">
                                {/* Agent & priority */}
                                <div className="flex items-center gap-1">
                                  {sub.model && (
                                    <span className="px-1 py-0.2 rounded border bg-[#fae8ff] text-[#86198f] border-[#f5d0fe]">
                                      {sub.model}
                                    </span>
                                  )}
                                  <span className={`px-1 py-0.2 rounded border uppercase ${
                                    sub.priority === 'high' ? 'bg-[#ffdacf] text-[#b43a20] border-[#ffa995]' :
                                    sub.priority === 'medium' ? 'bg-[#ffecca] text-[#a46c24] border-[#f0cca3]' :
                                    'bg-[#e2f0dc] text-[#4d7e35] border-[#bddda4]'
                                  }`}>
                                    {sub.priority}
                                  </span>
                                </div>

                                {/* Status badge */}
                                <span className={`px-1.5 py-0.4 rounded-lg border uppercase font-extrabold ${
                                  subDone ? 'bg-emerald-50 text-emerald-700 border-[#bddda4]/50' :
                                  subInProgress ? 'bg-orange-50 text-orange-700 border-orange-200/50' :
                                  'bg-white text-gray-400 border-gray-350/50'
                                }`}>
                                  {sub.status === 'in-progress' ? 'active' : sub.status}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : (
                    <div className="bg-white border-2 border-dashed border-[#e2d5c3]/60 rounded-2xl p-6 text-center select-none shadow-3xs">
                      <p className="text-[10px] font-mono text-[#a59182] font-extrabold uppercase tracking-wide">
                        🌿 No Linked Subtasks Configured
                      </p>
                      <p className="text-[9px] text-[#b4a091] font-mono mt-1 max-w-sm mx-auto">
                        This spec ticket stands alone as a singular release epic. Split it to isolate task files, logs, and agent assignments.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {/* 📂 TARGET FILES TO MODIFY SECTION */}
              <div className="space-y-2.5 border-t border-[#ebdcb9] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                  <FileCode size={13} className="text-[#bf8a50]" /> Target Files (ไฟล์ที่แก้ไข)
                </h4>
                {task.targetFiles && task.targetFiles.length > 0 ? (
                  <div className="space-y-1.5">
                    {task.targetFiles.map((f, i) => (
                      <div 
                        key={i} 
                        className="bg-[#ffffff] border border-[#ebdcb9] rounded-xl p-2.5 flex items-center justify-between text-[11px] font-mono text-[#bd7e3e] hover:border-[#dfa161] group/file shadow-2xs"
                      >
                        <span className="truncate pr-2 font-semibold">{f}</span>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText(f);
                            alert(`Copied file: ${f}`);
                          }}
                          className="opacity-0 group-hover/file:opacity-100 text-[#856c5a] hover:text-[#3a2010] px-2.5 py-1 bg-[#fffbf6] border border-[#ebdcb9] rounded-xl text-[9px] transition-all cursor-pointer font-bold"
                        >
                          copy
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-[#a59182] italic font-mono pl-1">No target files specified. Edit properties to add files.</p>
                )}
              </div>

              {/* Checklist steps SECTION */}
              <div className="space-y-2.5 border-t border-[#ebdcb9] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                  <CheckSquare size={13} className="text-[#728f44]" /> Mini-Tasks (สิ่งที่ต้องทำ)
                </h4>
                {task.checklist && task.checklist.length > 0 ? (
                  <div className="space-y-2">
                    {task.checklist.map((item) => (
                      <div 
                        key={item.id || item.text}
                        onClick={() => handleToggleChecklistItem(item.id || item.text)}
                        className={`p-3 rounded-xl border flex items-start gap-2.5 cursor-pointer transition-all shadow-2xs select-none ${
                          item.completed 
                            ? 'bg-[#e2f0dc]/45 border-[#bddda4]/50 text-gray-400 line-through' 
                            : 'bg-white border-[#ebdcb9] text-[#4d3d32] hover:bg-[#fffdfb] hover:border-[#c5b497]'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={item.completed}
                          onChange={() => {}} // toggled on container click
                          className="mt-0.5 rounded border-[#ebdcb9] text-[#7dad71] focus:ring-0 cursor-pointer pointer-events-none"
                        />
                        <span className="text-[11px] font-semibold select-none leading-relaxed">{item.text}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-[#a59182] italic font-mono pl-1 font-bold">No steps configured. Edit properties to define steps.</p>
                )}
              </div>

              {/* 🎨 DESIGN IMAGES & SPECIFICATION REFERENCE SECTION */}
              {((task.designImages && task.designImages.length > 0) || task.designImage || task.specUrl) && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-[#ebdcb9] pt-5 font-sans">
                  {((task.designImages && task.designImages.length > 0) || task.designImage) && (
                    <div className="space-y-2 col-span-1 md:col-span-2">
                      <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                        <ImageIcon size={13} className="text-[#bf8a50]" /> Design Mockup / Layout
                      </h4>
                      <div className="flex gap-2 overflow-x-auto pb-2 snap-x">
                        {(task.designImages || (task.designImage ? [task.designImage] : [])).map((img, idx) => (
                          <div key={idx} className="border border-[#ebdcb9] rounded-2xl overflow-hidden bg-white shadow-xs p-1 shrink-0 w-64 snap-center">
                            <a href={img} onClick={(e) => handleViewImage(e, img)} title="Click to view full image in a new tab">
                              <img 
                                src={img} 
                                alt={`Design Mockup ${idx + 1}`} 
                                className="w-full h-48 object-cover rounded-xl hover:opacity-90 transition-opacity cursor-pointer" 
                                referrerPolicy="no-referrer"
                              />
                            </a>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {task.specUrl && (
                    <div className="space-y-2 flex flex-col justify-start">
                      <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                        <LinkIcon size={13} className="text-[#3c829e]" /> Verification Specification Sheet
                      </h4>
                      <div className="bg-[#fffdfa] border border-[#ebdcb9]/60 hover:border-[#ebdcb9] p-4 rounded-2xl shadow-2xs flex flex-col gap-2.5 h-full relative justify-center">
                        <div className="flex items-center gap-2">
                          <div className="p-2 bg-[#e4eff3] rounded-xl text-[#3c829e]">
                            <LinkIcon size={16} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-bold text-[#354f59] tracking-tight truncate max-w-full">
                              {task.specUrl}
                            </p>
                            <p className="text-[9px] text-[#6d848c] font-mono leading-tight">Click link below to browse the specification workspace</p>
                          </div>
                        </div>
                        <a 
                          href={task.specUrl.startsWith('http') ? task.specUrl : `https://${task.specUrl}`} 
                          target="_blank" 
                          rel="noreferrer" 
                          className="w-full bg-[#3c829e] hover:bg-[#2e6d87] text-white text-center text-[10px] font-extrabold py-2 rounded-xl transition-all block cursor-pointer uppercase tracking-widest mt-1"
                        >
                          OPEN EXTERNAL SPEC SHEET ↗
                        </a>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Git Branch Block */}
              {task.branch && (
                <div className="space-y-2">
                  <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                    <GitBranch size={13} className="text-[#bf8a50]" /> Active Branch
                  </h4>
                  <div className="bg-[#fff9ee] border border-[#f5cb93] rounded-xl p-3 flex justify-between items-center text-[11px] font-mono text-[#9e6224] shadow-2xs">
                    <span className="truncate pr-4 font-bold">git checkout -b {task.branch}</span>
                    <button
                      type="button"
                      onClick={handleCopyCommand}
                      className="hover:text-[#ffffff] px-2.5 py-1 rounded-xl bg-white hover:bg-[#d89745] border border-[#ebdcb9] text-[10px] hover:border-transparent transition-all shrink-0 cursor-pointer text-[#816a5a] font-bold shadow-2xs"
                    >
                      {copied ? <Check size={11} className="text-emerald-500 font-bold" /> : 'Copy'}
                    </button>
                  </div>
                </div>
              )}

              {/* Detailed specification display */}
              {task.description && (
                <div className="space-y-2 border-t border-[#ebdcb9] pt-5">
                  <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 mb-3 font-bold">
                    <AlignLeft size={13} className="text-[#bf8a50]" /> Specifications Instruction sheet
                  </h4>
                  <div className="bg-[#ffffff] border border-[#ebdcb9] rounded-2xl p-4 text-[11px] font-mono text-[#5c493c] leading-relaxed overflow-x-auto shadow-2xs prose max-w-none select-text">
                    <MarkdownRenderer content={task.description} />
                  </div>
                </div>
              )}

              {/* Extra Info Fields */}
              {(task.reasoning || task.acceptanceCriteria || task.verification || task.repoContext || task.jiraKey || task.repo || task.sourceUrl) && (
                <div className="space-y-3 border-t border-[#ebdcb9] pt-5 font-mono text-[10.5px]">
                  
                  {/* Inline Metadata (Jira/Repo/SourceUrl) */}
                  {(task.jiraKey || task.repo || task.sourceUrl) && (
                    <div className="flex flex-wrap gap-3 mb-4">
                      {task.jiraKey && (
                        <div className="bg-[#e4eff3] text-[#354f59] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5">
                          <span className="text-[9px] uppercase tracking-wider opacity-80">Jira Key:</span> {task.jiraKey}
                        </div>
                      )}
                      {task.repo && (
                        <div className="bg-[#fffdfa] border border-[#ebdcb9] text-[#8a6e5a] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5">
                          <span className="text-[9px] uppercase tracking-wider">Repo:</span> {task.repo}
                        </div>
                      )}
                      {task.sourceUrl && (
                        <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="bg-[#fffdfa] border border-[#ebdcb9] text-[#3c829e] hover:text-[#2a7a8a] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
                          <span className="text-[9px] uppercase tracking-wider">Source URL ↗</span>
                        </a>
                      )}
                    </div>
                  )}

                  {task.reasoning && (
                    <div className="bg-[#fffdfa] border border-[#ebdcb9]/60 p-3 rounded-xl shadow-2xs">
                      <strong className="block text-[#8a6e5a] uppercase tracking-widest font-extrabold mb-1 text-[9px]">Reasoning & Context</strong>
                      <p className="text-[#5c493c] leading-relaxed whitespace-pre-wrap">{task.reasoning}</p>
                    </div>
                  )}
                  {task.acceptanceCriteria && (
                    <div className="bg-[#fffdfa] border border-[#ebdcb9]/60 p-3 rounded-xl shadow-2xs">
                      <strong className="block text-[#8a6e5a] uppercase tracking-widest font-extrabold mb-1 text-[9px]">Acceptance Criteria</strong>
                      <p className="text-[#5c493c] leading-relaxed whitespace-pre-wrap">{task.acceptanceCriteria}</p>
                    </div>
                  )}
                  {task.verification && (
                    <div className="bg-[#fffdfa] border border-[#ebdcb9]/60 p-3 rounded-xl shadow-2xs">
                      <strong className="block text-[#8a6e5a] uppercase tracking-widest font-extrabold mb-1 text-[9px]">Verification Steps</strong>
                      <p className="text-[#5c493c] leading-relaxed whitespace-pre-wrap">{task.verification}</p>
                    </div>
                  )}
                  {task.repoContext && (
                    <div className="bg-[#fffdfa] border border-[#ebdcb9]/60 p-3 rounded-xl shadow-2xs">
                      <strong className="block text-[#8a6e5a] uppercase tracking-widest font-extrabold mb-1 text-[9px]">Repository Context</strong>
                      <p className="text-[#5c493c] leading-relaxed whitespace-pre-wrap">{task.repoContext}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Activity Logs */}
          <div className="border-t border-[#ebdcb9] pt-6 space-y-4">
            <h4 className="text-[10px] font-mono text-[#8a6e5a] uppercase tracking-widest flex items-center gap-1.5 font-bold">
              <Activity size={13} className="text-gray-500" /> Backlog Activity & Developer Logs
            </h4>

            {/* Event list */}
            <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
              {[...task.logs]
                .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                .map((log) => (
                  <div 
                    key={log.id} 
                    className={`p-3 rounded-xl border flex flex-col gap-1 text-[10px] font-mono leading-relaxed shadow-3xs transition-all ${
                      log.type === 'create' ? 'bg-[#edf7ed] border-[#c9e7cb] text-[#427931]' : 
                      log.type === 'move' ? 'bg-[#fff5e5] border-[#fde5bd] text-[#935919]' :
                      log.type === 'comment' ? 'bg-[#fffdfa] border-[#ebdcb9] text-[#55453B] font-semibold' :
                      'bg-white border-[#ebdcb9] text-[#715c4d]'
                    }`}
                  >
                    <div className="flex justify-between items-center text-[8px] text-[#a08b7e] font-extrabold uppercase">
                      <span className="flex items-center gap-1">
                        <Clock size={10} />
                        {log.type} entry
                      </span>
                      <span>{new Date(log.timestamp).toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{log.message}</p>
                  </div>
                ))}
            </div>

            {/* Developer Notes Addition input */}
            <form onSubmit={handleAddComment} className="flex gap-2 font-mono">
              <input
                type="text"
                className="flex-1 bg-white border border-[#ebdcb9] rounded-xl px-3.5 py-2 text-xs text-[#534135] placeholder-[#c4b3a4] outline-none focus:border-[#d4994e] font-mono"
                placeholder="Drop developer run comments or logs..."
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
              />
              <button
                type="submit"
                className="bg-[#fff9ee] hover:bg-[#ebdcb9] text-[#856b5a] border border-[#ebdcb9] px-4 rounded-xl flex items-center justify-center cursor-pointer transition-colors hover:shadow-2xs"
                title="Append statement comment Log"
              >
                <Plus size={15} />
              </button>
            </form>
          </div>
        </div>

        {/* Footer actions */}
        <div className="p-4 bg-[#ebdcb9]/40 border-t border-[#ebdcb9] flex justify-end gap-3 text-xs font-mono">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white border border-[#ebdcb9] text-[#6d5a4d] hover:bg-[#fffcf6] rounded-xl font-bold font-mono transition-colors cursor-pointer shadow-3xs"
          >
            Close Spec Sheets
          </button>
        </div>
      </div>

      {isAddingSubtask && onCreateTask && (
        <CreateTaskModal
          onClose={() => setIsAddingSubtask(false)}
          parentId={task.id}
          parentTitle={task.title}
          onSubmit={async (subtaskData) => {
            await onCreateTask(subtaskData);
            setIsAddingSubtask(false);
          }}
        />
      )}
    </div>
  );
}
