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
  ClipboardPaste as Clipboard,
  Image as ImageIcon,
  Link as LinkIcon,
  ChevronDown,
  FlaskConical,
  Code2,
  ExternalLink
, Bot, Zap} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { Task, TaskPriority, TaskStatus, LogEntry, ChecklistItem, TaskCategory } from '../types';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';
import { getAutoWorkState } from '../lib/autoWorkState';
import MarkdownRenderer from './MarkdownRenderer';
import CopyTemplateButton from './CopyTemplateButton';
import CreateTaskModal from './CreateTaskModal';
import { AgentLogo } from './AgentLogo';
import ImageViewer from './ImageViewer';
import { TaskImage } from '../types';
import { useTaskDrawerViewModel } from '../viewModels/useTaskDrawerViewModel';

interface TaskDetailsDrawerProps {
  task: Task;
  allTasks?: Task[];
  onSelectTask?: (task: Task) => void;
  onClose: () => void;
  onUpdate: (updatedTask: Task) => void;
  onDelete: (id: string) => void;
  onCreateTask?: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => Promise<void>;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

interface RunHistoryFiles {
  runDir: string;
  promptPath: string;
  logPath: string;
  launchMetadataPath: string;
  outputSummaryPath: string;
  resultPath: string;
}

export default function TaskDetailsDrawer({ 
  task, 
  allTasks = [], 
  onSelectTask, 
  onClose, 
  onUpdate, 
  onDelete,
  onCreateTask,
  onShowLog
}: TaskDetailsDrawerProps) {
  // View-model for save/load/refresh/toggle (DVF-0210)
  const drawerViewModel = useTaskDrawerViewModel();
  // Bridge: when the parent task changes, refetch via the view-model so edit state stays in sync.
  useEffect(() => {
    if (drawerViewModel.task && drawerViewModel.task.id !== task.id) {
      void drawerViewModel.open(task.id);
    } else if (!drawerViewModel.task) {
      void drawerViewModel.open(task.id);
    }
  }, [task.id]);

  const parentTask = task.parentId ? allTasks.find(t => t.id === task.parentId) : undefined;
  const subTasks = allTasks.filter(t => t.parentId === task.id);
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedDesc, setEditedDesc] = useState(task.description);
  const [editedBranch, setEditedBranch] = useState(task.branch || '');
  const [editedPriority, setEditedPriority] = useState<TaskPriority>(task.priority);
  const [editedCategory, setEditedCategory] = useState<TaskCategory>(task.category || 'general');
  const [editedStatus, setEditedStatus] = useState<TaskStatus>(task.status);

  // New properties editing states
  const [editedFilesList, setEditedFilesList] = useState<string[]>(task.targetFiles || []);
  const [editedChecklistList, setEditedChecklistList] = useState<string[]>((task.checklist || []).map(c => c.text));
  const [editedImages, setEditedImages] = useState<TaskImage[]>(task.images || []);
  const [viewingImage, setViewingImage] = useState<TaskImage | null>(null);
  const [editedSpecUrl, setEditedSpecUrl] = useState(task.specUrl || '');

  const uploadImage = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        const img = await res.json();
        setEditedImages((prev) => [...prev, img]);
      }
    } catch (err) {
      console.error('Upload failed:', err);
    }
  };

  const handlePasteImage = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items);
    const imageItem = items.find((item) => item.type.startsWith('image/'));
    if (!imageItem) return;
    e.preventDefault();
    const blob = imageItem.getAsFile();
    if (!blob) return;
    await uploadImage(blob);
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
  const [copiedHistoryPath, setCopiedHistoryPath] = useState<string | null>(null);
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [runHistoryFiles, setRunHistoryFiles] = useState<RunHistoryFiles | null>(null);
  const [isRetryingRun, setIsRetryingRun] = useState(false);
  const [latestRunLogContent, setLatestRunLogContent] = useState('');
  const [latestRunLogExists, setLatestRunLogExists] = useState(false);
  const [latestRunLogLoading, setLatestRunLogLoading] = useState(false);
  const [latestRunLogError, setLatestRunLogError] = useState<string | null>(null);

  // Progressive disclosure state
  const [showAllFiles, setShowAllFiles] = useState(false);
  const [showAllChecklist, setShowAllChecklist] = useState(false);
  const [showAllSubtasks, setShowAllSubtasks] = useState(false);
  // Accordion open state — empty = all collapsed
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const [activeLogTab, setActiveLogTab] = useState<'notes' | 'autowork' | 'history'>('notes');

  const toggleSection = (key: string) => {
    setOpenSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const handleAccordionClick = (e: React.MouseEvent<HTMLButtonElement>, key: string) => {
    const isOpening = !openSections.has(key);
    toggleSection(key);
    if (isOpening) {
      const target = e.currentTarget;
      setTimeout(() => {
        target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 150);
    }
  };

  // Reset progressive disclosure and accordion states only when task identity changes
  useEffect(() => {
    setShowAllFiles(false);
    setShowAllChecklist(false);
    setShowAllSubtasks(false);
    setOpenSections(new Set());
  }, [task.id]);

  // Sync state with task changes
  useEffect(() => {
    if (!isEditing) {
      setEditedTitle(task.title);
      setEditedDesc(task.description);
      setEditedBranch(task.branch || '');
      setEditedPriority(task.priority);
      setEditedCategory(task.category || 'general');
      setEditedStatus(task.status);
      setEditedFilesList(task.targetFiles || []);
      setEditedChecklistList((task.checklist || []).map(c => c.text));
      setEditedImages(task.images || []);
      setEditedSpecUrl(task.specUrl || '');
      setEditedAgent(task.agent || '');
      setEditedModel(task.model || '');
      setEditedEffort(task.effort || '');
    }
  }, [task, isEditing]);

  useEffect(() => {
    let cancelled = false;
    setRunHistoryFiles(null);

    const runId = task.latestAgentRun?.id;
    if (!runId) return;

    fetch(`/api/tasks/${task.id}/agent-runs/${runId}/history`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json();
      })
      .then((data) => {
        if (cancelled || !data?.files) return;
        setRunHistoryFiles(data.files);
      })
      .catch(() => {
        if (!cancelled) setRunHistoryFiles(null);
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.latestAgentRun?.id]);

  useEffect(() => {
    let cancelled = false;
    setLatestRunLogContent('');
    setLatestRunLogExists(false);
    setLatestRunLogError(null);

    const runId = task.latestAgentRun?.id;
    if (!runId) return;

    setLatestRunLogLoading(true);
    fetch(`/api/tasks/${task.id}/agent-runs/${runId}/log`)
      .then(async (response) => {
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(data?.error || `Failed to load log (${response.status})`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setLatestRunLogContent(typeof data?.content === 'string' ? data.content : '');
        setLatestRunLogExists(Boolean(data?.exists));
      })
      .catch((error) => {
        if (cancelled) return;
        setLatestRunLogError(error?.message || 'Failed to load log');
      })
      .finally(() => {
        if (!cancelled) setLatestRunLogLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [task.id, task.latestAgentRun?.id]);

  const handleSave = () => {
    if (!editedTitle.trim()) return;

    const tagsArray: string[] = [];

    const filesArray = editedFilesList
      .map(f => f.trim())
      .filter(f => f.length > 0);

    const checklistLines = editedChecklistList
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
      category: editedCategory,
      status: editedStatus,
      tags: tagsArray,
      targetFiles: filesArray,
      checklist: parsedChecklist,
      images: editedImages.length > 0 ? editedImages : undefined,
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
    // Delegate the pure flip to the view-model. The log message + history update is preserved
    // here so the existing audit trail (in the drawer's local state) keeps working.
    drawerViewModel.toggleChecklist(itemIdentifier);

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
      checklist: (task.checklist || []).map(item => {
        const currentIdentifier = item.id || item.text;
        if (currentIdentifier === itemIdentifier) {
          return { ...item, completed: !item.completed };
        }
        return item;
      }),
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

  const handleCopyHistoryPath = (pathValue: string) => {
    navigator.clipboard.writeText(pathValue);
    setCopiedHistoryPath(pathValue);
    setTimeout(() => setCopiedHistoryPath(null), 2000);
  };

  const latestRun = task.latestAgentRun;
  const autoWorkState = getAutoWorkState(task);
  const canRetryLatestRun = !!latestRun && !task.activeAgent && ['failed', 'cancelled'].includes(latestRun.status);
  const latestRunLogTail = latestRunLogContent.trim()
    ? latestRunLogContent.trimEnd().split(/\r?\n/).slice(-40).join('\n')
    : '';

  const handleRetryLatestRun = async () => {
    if (!latestRun || isRetryingRun) return;
    setIsRetryingRun(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/agent-runs/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body?.error || `Retry failed with status ${response.status}`);
      }
      if (body?.task) {
        onUpdate(body.task);
      }
    } catch (error) {
      console.error('Failed to retry latest run:', error);
    } finally {
      setIsRetryingRun(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text" onPaste={handlePasteImage}>
      {/* Backdrop click-away */}
      <div className="fixed inset-0" onClick={onClose} />
      
      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />

      {/* Centered Spec Sheet Modal Container */}
      <div className="bg-[#fcf9f4] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-3xl h-[85vh] rounded-3xl shadow-2xl relative z-10 overflow-hidden flex flex-col justify-between font-sans">
        
        {/* Custom Header bar */}
        <div className="p-5 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between font-mono text-[#5c493c] dark:text-[#f3eadf]">
          <div className="flex items-center gap-2">
            <button 
              type="button"
              onClick={handleCopyId}
              className="flex items-center gap-1.5 text-[10px] uppercase font-bold text-[#8a6e5a] dark:text-[#f3eadf] hover:text-[#d89745] dark:text-[#d6b56d] dark:hover:text-[#e0a070] dark:text-[#d6b56d] bg-[#fffbf4] dark:bg-[#292119] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/30 px-2.5 py-1 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] transition-colors cursor-pointer"
              title="Copy Card ID"
            >
              ID: {task.displayId || task.id}
              {idCopied ? (
                <Check size={11} className="text-emerald-500" />
              ) : (
                <Copy size={11} className="opacity-40 hover:opacity-100" />
              )}
            </button>
            <span className="h-4 w-px bg-[#ebdcb9] dark:bg-[#584a3b]" />
            <span className="text-[10px] text-[#8a6e5a] dark:text-[#f3eadf] font-semibold">
              Updated at {new Date(task.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className="text-[11px] font-mono bg-[#fffbf4] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] text-[#6e5340] dark:text-[#f3eadf] hover:bg-[#fff9ed] dark:hover:bg-[#1e1914] px-3 py-1.5 rounded-xl flex items-center gap-2 transition-all cursor-pointer shadow-2xs mr-1"
            >
              {isEditing ? (
                <>
                  <BookOpen size={13} className="text-[#38b000] dark:text-[#f3eadf]" />
                  <span className="font-bold">Preview Spec</span>
                </>
              ) : (
                <>
                  <Edit3 size={13} className="text-[#e5a93b] dark:text-[#d6b56d]" />
                  <span className="font-bold">Edit Spec</span>
                </>
              )}
            </button>
            <button
              onClick={() => onDelete(task.id)}
              type="button"
              className="text-[#9e8b7e] dark:text-[#d6b56d] hover:text-red-500 p-2 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
              title="Delete ticket"
            >
              <Trash2 size={16} />
            </button>
            <button
              onClick={onClose}
              type="button"
              className="text-[#9e8b7e] dark:text-[#d6b56d] hover:text-[#5c493c] dark:text-[#f3eadf] dark:hover:text-[#f3eadf] p-2 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer"
              title="Close panel"
            >
              <X size={17} />
            </button>
          </div>
        </div>

        {/* Scrollable spec sheets details */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4 scrollbar-thin">
          
          {/* Parent Context Banner */}
          {parentTask && (
            <div className="bg-[#f2ece5]/80 dark:bg-[#292119]/80 border border-[#d6cbbe] dark:border-[#584a3b] rounded-2xl p-4.5 flex flex-col md:flex-row items-start md:items-center justify-between gap-4 font-sans select-none animate-fade-in shadow-xs">
              <div className="space-y-1">
                <span className="text-[10px] font-mono uppercase bg-[#ffffff] dark:bg-[#292119] text-[#8c7463] dark:text-[#f3eadf] px-2 py-0.5 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] font-extrabold">
                  🌿 Linked Subtask Spec
                </span>
                <h4 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] leading-snug line-clamp-1 mt-1 font-sans">
                  Parent: #{parentTask.displayId || parentTask.id} • {parentTask.title}
                </h4>
                <p className="text-[10.5px] text-[#8c7463] dark:text-[#f3eadf] font-sans">
                  This task constitutes a nested modular checkpoint of its parent workspace ticket.
                </p>
              </div>
              {onSelectTask && (
                <button
                  type="button"
                  onClick={() => onSelectTask(parentTask)}
                  className="bg-white dark:bg-[#292119] hover:bg-[#fff9ed] dark:hover:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] hover:border-[#d4994e] dark:border-[#e0a070] dark:hover:border-[#584a3b] text-[#6e5340] dark:text-[#f3eadf] font-extrabold px-3 py-1.5 rounded-xl text-[10.5px] flex items-center gap-1.5 transition-all shadow-4xs cursor-pointer hover:shadow-2xs active:scale-[0.98] shrink-0"
                >
                  <Cat size={12} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Open Parent Card
                </button>
              )}
            </div>
          )}

          {isEditing ? (
            /* ================= EDIT MODE SPECIFICATION ================= */
            <div className="space-y-4 text-[#5c493c] dark:text-[#f3eadf]">
              <div className="flex flex-col gap-3">
                <input
                  type="text"
                  className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-sm font-extrabold text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans transition-all"
                  placeholder="Task Title"
                  value={editedTitle}
                  onChange={(e) => setEditedTitle(e.target.value)}
                />
                
                <div className="flex items-center gap-2 flex-wrap">
                  <CustomSelect
                    className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg px-2 py-1.5 text-[10px] uppercase font-bold text-[#3a2f26] dark:text-[#f3eadf] transition-all min-w-[140px]"
                    value={editedStatus}
                    onChange={(val) => setEditedStatus(val as TaskStatus)}
                    options={[
                      { value: 'backlog', label: 'Backlog Lane' },
                      { value: 'todo', label: 'To Do Lane' },
                      { value: 'in-progress', label: 'In Progress Lane' },
                      { value: 'ready-for-review', label: 'Ready for Review Lane' },
                      { value: 'done', label: 'Done Lane' }
                    ]}
                  />
                  
                  <CustomSelect
                    className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg px-2 py-1.5 text-[10px] uppercase font-bold text-[#3a2f26] dark:text-[#f3eadf] transition-all min-w-[130px]"
                    value={editedPriority}
                    onChange={(val) => setEditedPriority(val as TaskPriority)}
                    options={[
                      { value: 'low', label: 'Low Severity' },
                      { value: 'medium', label: 'Medium Severity' },
                      { value: 'high', label: 'High Severity' }
                    ]}
                  />
                  
                  <CustomSelect
                    className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg px-2 py-1.5 text-[10px] uppercase font-bold text-[#3a2f26] dark:text-[#f3eadf] transition-all min-w-[130px]"
                    value={editedCategory}
                    onChange={(val) => setEditedCategory(val as TaskCategory)}
                    options={[
                      { value: 'general', label: 'General / Fullstack' },
                      { value: 'frontend', label: 'Frontend / UI' },
                      { value: 'backend', label: 'Backend / Infra' }
                    ]}
                  />
                  
                  <div className="flex items-center gap-1.5 ml-auto">
                    <GitBranch size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" />
                    <input
                      type="text"
                      className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg px-2 py-1 text-[10px] text-[#b87332] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono min-w-[160px]"
                      placeholder="Branch name"
                      value={editedBranch}
                      onChange={(e) => setEditedBranch(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 px-3 py-2 bg-[#fdfbf7]/70 dark:bg-[#292119]/70 border border-[#ebdcb9]/50 dark:border-[#584a3b]/50 rounded-xl text-[10px] font-mono flex-wrap w-fit">
                <CustomSelect
                  className="bg-transparent text-[#5c493c] dark:text-[#f3eadf] font-bold min-w-[110px]"
                  value={editedAgent}
                  onChange={(val) => {
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
                  options={[
                    { value: '', label: 'Unassigned', icon: <Bot size={13} className="opacity-60" /> },
                    { value: 'Codex', label: 'Codex', icon: <AgentLogo agent="Codex" size={13} /> },
                    { value: 'Antigravity', label: 'Antigravity', icon: <AgentLogo agent="Antigravity" size={13} /> },
                    { value: 'Claude', label: 'Claude', icon: <AgentLogo agent="Claude" size={13} /> }
                  ]}
                />

                {editedAgent && <span className="text-[#c4b3a4] dark:text-[#584a3b]">·</span>}
                <CustomSelect
                  className={`bg-transparent text-[#8a6e5a] dark:text-[#d6b56d] font-bold min-w-[130px] ${!editedAgent ? 'opacity-50 pointer-events-none' : ''}`}
                  value={editedModel}
                  onChange={(val) => {
                    setEditedModel(val);
                    if (editedAgent && val) {
                      setEditedEffort(defaultEffortForModel(editedAgent, val));
                    } else {
                      setEditedEffort('');
                    }
                  }}
                  options={[
                    { value: '', label: 'None / Default' },
                    ...(editedAgent ? (AGENTS_CONFIG[editedAgent as import('../lib/agentsConfig').AgentName] || []).map(m => ({
                      value: m.model_name,
                      label: m.display_name || m.label || m.model_name
                    })) : [])
                  ]}
                />

                {editedModel && <span className="text-[#c4b3a4] dark:text-[#584a3b]">·</span>}
                <CustomSelect
                  className={`bg-transparent text-[#8a6e5a] dark:text-[#d6b56d] font-bold min-w-[90px] ${(!editedAgent || !editedModel) ? 'opacity-50 pointer-events-none' : ''}`}
                  value={editedEffort}
                  onChange={(val) => setEditedEffort(val)}
                  options={[
                    { value: '', label: 'No Effort' },
                    ...(editedAgent && editedModel ? (getModelConfig(editedAgent, editedModel)?.availableEfforts || []).map(eff => ({
                      value: eff,
                      label: eff === 'xhigh' ? 'Extra High' : eff.charAt(0).toUpperCase() + eff.slice(1),
                      icon: <Zap size={11} className="text-[#d89745] dark:text-[#d6b56d]" />
                    })) : []),
                    ...((editedEffort && editedAgent && editedModel && !getModelConfig(editedAgent, editedModel)?.availableEfforts.includes(editedEffort as any)) 
                      ? [{ value: editedEffort, label: `${editedEffort} (Unsupported)`, icon: <Zap size={11} className="text-red-500" /> }] 
                      : [])
                  ]}
                />
              </div>

              <div className="space-y-2.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1.5"><FileCode size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Target Files (ไฟล์ที่แก้ไข)</span>
                </h4>
                <div className="space-y-2">
                  {editedFilesList.map((file, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        className="flex-1 bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono shadow-2xs"
                        placeholder="app/src/main/java/com/example/MainActivity.kt"
                        value={file}
                        onChange={(e) => {
                          const newList = [...editedFilesList];
                          newList[idx] = e.target.value;
                          setEditedFilesList(newList);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const newList = editedFilesList.filter((_, i) => i !== idx);
                          setEditedFilesList(newList);
                        }}
                        className="p-2 text-[#c4b3a4] dark:text-[#b8ab9f] hover:text-red-500 transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setEditedFilesList([...editedFilesList, ''])}
                    className="flex items-center gap-1.5 text-[10px] font-bold text-[#bf8a50] dark:text-[#d6b56d] hover:text-[#d7933f] dark:hover:text-[#f3eadf] transition-colors px-2 py-1 cursor-pointer"
                  >
                    <Plus size={12} /> Add Target File
                  </button>
                </div>
              </div>

              <div className="space-y-2.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center justify-between font-bold">
                  <span className="flex items-center gap-1.5"><CheckSquare size={13} className="text-[#728f44] dark:text-[#f3eadf]" /> Mini-Tasks (สิ่งที่ต้องทำ)</span>
                </h4>
                <div className="space-y-2">
                  {editedChecklistList.map((step, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="text"
                        className="flex-1 bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono shadow-2xs"
                        placeholder="Task step..."
                        value={step}
                        onChange={(e) => {
                          const newList = [...editedChecklistList];
                          newList[idx] = e.target.value;
                          setEditedChecklistList(newList);
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const newList = editedChecklistList.filter((_, i) => i !== idx);
                          setEditedChecklistList(newList);
                        }}
                        className="p-2 text-[#c4b3a4] dark:text-[#b8ab9f] hover:text-red-500 transition-colors cursor-pointer"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={() => setEditedChecklistList([...editedChecklistList, ''])}
                    className="flex items-center gap-1.5 text-[10px] font-bold text-[#728f44] dark:text-[#a3c773] hover:text-[#5a7336] transition-colors px-2 py-1 cursor-pointer"
                  >
                    <Plus size={12} /> Add Mini-Task
                  </button>
                </div>
              </div>

              <div className="space-y-2.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                  <AlignLeft size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Detailed Specifications & Code (Markdown)
                </h4>
                <textarea
                  className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] h-32 outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all resize-y font-mono shadow-2xs"
                  placeholder="Insert architecture blueprint markdown notes..."
                  value={editedDesc}
                  onChange={(e) => setEditedDesc(e.target.value)}
                />
              </div>

              {/* Links & References Accordion */}
              <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                <button
                  type="button"
                  onClick={(e) => handleAccordionClick(e, 'edit-links')}
                  className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-[#bf8a50]/10 dark:bg-[#bf8a50]/20 flex items-center justify-center">
                      <LinkIcon size={12} className="text-[#bf8a50] dark:text-[#d6b56d]" />
                    </div>
                    <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Links & References</span>
                  </div>
                  <ChevronDown 
                    size={14} 
                    className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('edit-links') ? 'rotate-180' : ''}`}
                  />
                </button>
                
                {openSections.has('edit-links') && (
                  <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-sans">
                      {/* Image Upload UI */}
                      <div className="space-y-2 col-span-1 md:col-span-2">
                        <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                          <ImageIcon size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Design Mockup / Layout
                        </h4>
                        <div className="space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <label className="text-[10px] bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1.5 rounded-lg text-[#5c493c] dark:text-[#f3eadf] hover:bg-[#fffcf6] cursor-pointer inline-flex items-center gap-1 font-bold transition-colors">
                              <span>Upload Image(s) {editedImages.length > 0 && `(${editedImages.length})`}</span>
                              <input
                                type="file"
                                accept="image/*"
                                multiple
                                className="hidden"
                                onChange={(e) => {
                                  const files = Array.from(e.target.files || []);
                                  files.forEach(file => uploadImage(file));
                                }}
                              />
                            </label>
                            
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.read().then(async items => {
                                  for (const item of items) {
                                    if (item.types.some(t => t.startsWith('image/'))) {
                                      const blob = await item.getType(item.types.find(t => t.startsWith('image/'))!);
                                      const file = new File([blob], "pasted-image.png", { type: blob.type });
                                      await uploadImage(file);
                                    }
                                  }
                                }).catch(() => {});
                              }}
                              className="text-[10px] bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] px-2.5 py-1.5 rounded-lg text-[#5c493c] dark:text-[#f3eadf] hover:bg-[#fffcf6] cursor-pointer inline-flex items-center gap-1 font-bold transition-colors"
                            >
                              <Clipboard size={12} /> Paste from clipboard
                            </button>
                            {editedImages.length > 0 && (
                              <button
                                type="button"
                                onClick={() => setEditedImages([])}
                                className="text-[10px] text-red-500 font-bold hover:underline cursor-pointer"
                              >
                                Clear All
                              </button>
                            )}
                          </div>
                          {editedImages.length > 0 && (
                            <div className="flex gap-2 overflow-x-auto pb-1 mt-2">
                              {editedImages.map((img) => (
                                <div key={img.id} className="relative border border-[#ebdcb9] dark:border-[#584a3b] rounded-lg overflow-hidden h-14 w-14 shrink-0 bg-white dark:bg-[#292119] group cursor-pointer" onClick={() => setViewingImage(img)}>
                                  <img src={img.url} alt={img.filename} className="h-full w-full object-cover" referrerPolicy="no-referrer" />
                                  <button 
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); setEditedImages(prev => prev.filter((i) => i.id !== img.id)); }}
                                    className="absolute top-0 right-0 bg-red-500 text-white dark:text-[#f3eadf] w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer rounded-bl-md"
                                  >
                                    ✕
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Spec URL */}
                      <div className="space-y-2 flex flex-col justify-start">
                        <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                          <LinkIcon size={13} className="text-[#3c829e] dark:text-[#f3eadf]" /> Specification link / URL
                        </h4>
                        <input
                          type="text"
                          className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-2.5 py-2 text-[11px] text-[#3a2f26] dark:text-[#f3eadf] placeholder-[#c4b3a4] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-sans shadow-2xs"
                          placeholder="e.g. Figma link or API Doc URL"
                          value={editedSpecUrl}
                          onChange={(e) => setEditedSpecUrl(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* QA Context Accordion */}
              <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                <button
                  type="button"
                  onClick={(e) => handleAccordionClick(e, 'edit-qa')}
                  className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-[#7dad71]/10 dark:bg-[#7dad71]/20 flex items-center justify-center">
                      <FlaskConical size={12} className="text-[#7dad71] dark:text-[#d6b56d]" />
                    </div>
                    <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">QA Context</span>
                  </div>
                  <ChevronDown 
                    size={14} 
                    className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('edit-qa') ? 'rotate-180' : ''}`}
                  />
                </button>
                
                {openSections.has('edit-qa') && (
                  <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                    <div className="grid grid-cols-1 gap-4 font-sans text-xs">
                      <div className="space-y-1.5">
                        <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[10px]">Acceptance Criteria</strong>
                        <textarea
                          className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] h-20 outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all resize-y font-mono shadow-2xs"
                          value={editedAcceptance}
                          onChange={(e) => setEditedAcceptance(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[10px]">Verification Steps</strong>
                        <textarea
                          className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] h-20 outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all resize-y font-mono shadow-2xs"
                          value={editedVerification}
                          onChange={(e) => setEditedVerification(e.target.value)}
                        />
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Dev Context Accordion */}
              <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                <button
                  type="button"
                  onClick={(e) => handleAccordionClick(e, 'edit-dev')}
                  className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-6 h-6 rounded-lg bg-[#3c829e]/10 dark:bg-[#3c829e]/20 flex items-center justify-center">
                      <Code2 size={12} className="text-[#3c829e] dark:text-[#d6b56d]" />
                    </div>
                    <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Dev Context</span>
                  </div>
                  <ChevronDown 
                    size={14} 
                    className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('edit-dev') ? 'rotate-180' : ''}`}
                  />
                </button>
                
                {openSections.has('edit-dev') && (
                  <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                    <div className="flex flex-col gap-4 font-sans text-xs">
                      <div className="space-y-1.5">
                        <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[10px]">Reasoning & Context</strong>
                        <textarea
                          className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] h-20 outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all resize-y font-mono shadow-2xs"
                          value={editedReasoning}
                          onChange={(e) => setEditedReasoning(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1.5">
                        <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[10px]">Repository Context</strong>
                        <textarea
                          className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] h-20 outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all resize-y font-mono shadow-2xs"
                          value={editedRepoContext}
                          onChange={(e) => setEditedRepoContext(e.target.value)}
                        />
                      </div>
                      
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <label className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Jira Issue Key</label>
                          <input
                            type="text"
                            className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono shadow-2xs"
                            placeholder="QCA-3314"
                            value={editedJiraKey}
                            onChange={(e) => setEditedJiraKey(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Repository URL</label>
                          <input
                            type="text"
                            className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono shadow-2xs"
                            placeholder="https://github.com/org/repo"
                            value={editedRepo}
                            onChange={(e) => setEditedRepo(e.target.value)}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Source URL</label>
                          <input
                            type="text"
                            className="w-full bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 text-xs text-[#3a2f26] dark:text-[#f3eadf] outline-none focus:border-[#d7933f] dark:border-[#e0a070] dark:focus:border-[#584a3b] transition-all font-mono shadow-2xs"
                            placeholder="https://jira.../browse/..."
                            value={editedSourceUrl}
                            onChange={(e) => setEditedSourceUrl(e.target.value)}
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 left-0 right-0 z-20 flex gap-3 pt-4 pb-4 bg-gradient-to-t from-[#fdfbf7] via-[#fdfbf7] to-transparent dark:from-[#292119] dark:via-[#292119] border-t border-[#ebdcb9]/0 dark:border-[#584a3b]/0 mt-8">
                <div className="flex gap-3 w-full bg-[#fdfbf7] dark:bg-[#292119] p-3 rounded-2xl shadow-[0_-4px_24px_rgba(200,180,160,0.2)] dark:shadow-[0_-4px_24px_rgba(0,0,0,0.5)] border border-[#ebdcb9] dark:border-[#584a3b]">
                  <button
                    type="button"
                    onClick={() => setIsEditing(false)}
                    className="flex-1 py-2 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] text-[#6e5a4d] dark:text-[#f3eadf] bg-white dark:bg-[#292119] hover:bg-[#fff9ed] dark:hover:bg-[#1e1914] transition-colors text-xs font-bold cursor-pointer"
                  >
                    Discard Changes
                  </button>
                  <button
                    type="button"
                    onClick={handleSave}
                    className="flex-1 bg-[#d89745] dark:bg-[#e0a070] hover:bg-[#c08234] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] font-extrabold py-2 rounded-xl text-xs transition-colors cursor-pointer shadow-sm"
                  >
                    Save Modifications
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* ================= PREVIEW / VIEW MODE ================= */
            <div className="space-y-4 text-[#5c493c] dark:text-[#f3eadf]">
              {/* Header Section (Title, Branch, Agent) grouped to reduce padding */}
              <div className="flex flex-col gap-2.5">
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="text-sm font-extrabold text-[#3a2f26] dark:text-[#f3eadf] font-sans tracking-tight leading-snug">
                      {task.title}
                    </h2>
                    <CopyTemplateButton task={task} className="py-1 px-3 text-[10px] rounded-lg shrink-0" />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                  {/* Status chip */}
                  <span className={`inline-flex items-center justify-center leading-none text-[9px] uppercase font-bold px-2 py-1 rounded-lg border ${
                    task.status === 'done' ? 'bg-[#e2f0dc] dark:bg-[#292119] text-[#4d7e35] dark:text-[#f3eadf] border-[#bddda4] dark:border-[#584a3b]' :
                    task.status === 'in-progress' ? 'bg-[#ffecca] dark:bg-[#292119] text-[#a46c24] dark:text-[#f3eadf] border-[#f0cca3] dark:border-[#584a3b]' :
                    'bg-[#f4ebd9]/60 dark:bg-[#292119]/60 text-[#715c4d] dark:text-[#f3eadf] border-[#ebdcb9] dark:border-[#584a3b]'
                  }`}>{task.status}</span>
                  {/* Category chip */}
                  {task.category && task.category !== 'general' && (
                    <span className={`inline-flex items-center justify-center leading-none text-[9px] uppercase font-bold px-2 py-1 rounded-lg border gap-1.5 ${
                      task.category === 'backend' ? 'bg-[#f0e6e1] dark:bg-[#3d332d] text-[#6d5445] dark:text-[#d6c7be] border-[#d8cfc9] dark:border-[#584a3b]' :
                      'bg-[#e1eff5] dark:bg-[#2d3a40] text-[#3c829e] dark:text-[#a8c9d6] border-[#c9dbe3] dark:border-[#584a3b]'
                    }`}>
                      {task.category}
                    </span>
                  )}
                  {/* Priority chip */}
                  <span className={`inline-flex items-center justify-center leading-none text-[9px] uppercase font-bold px-2 py-1 rounded-lg border gap-1.5 ${
                    task.priority === 'high' ? 'bg-red-50 dark:bg-[#3d241d] text-red-600 dark:text-[#e07b69] border-red-200 dark:border-[#8f4133]' :
                    task.priority === 'medium' ? 'bg-amber-50 dark:bg-[#3b2b1a] text-amber-700 dark:text-[#e6b96e] border-amber-200 dark:border-[#8f6833]' :
                    'bg-emerald-50 dark:bg-[#1f2e1a] text-emerald-700 dark:text-[#90cf7e] border-emerald-200 dark:border-[#528a3b]'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${
                      task.priority === 'high' ? 'bg-red-500' : task.priority === 'medium' ? 'bg-amber-500' : 'bg-emerald-500'
                    }`} />
                    {task.priority || 'low'}
                  </span>
                  <span className="text-[9px] text-[#9b8575] dark:text-[#d6b56d] font-mono">
                    born {new Date(task.createdAt).toLocaleDateString()}
                  </span>
                </div>
              </div>

              {/* Git Branch & Agent Handoff */}
              {task.branch && (
                <div className="flex items-center justify-between">
                  <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] tracking-widest flex items-center gap-1.5 font-bold">
                    <GitBranch size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> <span className="uppercase">Active Branch:</span> <span className="text-[#9e6224] dark:text-[#e0a070] dark:text-[#d6b56d]">{task.branch}</span>
                  </h4>
                </div>
              )}


              {/* Agent Strip — compact 1-line pill */}
              {(task.agent || task.model) && (
                <div className="flex items-center gap-2 px-3 py-2 bg-[#fdfbf7]/70 dark:bg-[#292119]/70 border border-[#ebdcb9]/50 dark:border-[#584a3b]/50 rounded-xl text-[10px] font-mono w-fit">
                  {task.agent && (
                    <>
                      <AgentLogo agent={task.agent} size={11} className="shrink-0" />
                      <span className="font-bold text-[#5c493c] dark:text-[#f3eadf]">{task.agent}</span>
                    </>
                  )}
                  {task.agent && task.model && <span className="text-[#c4b3a4] dark:text-[#584a3b]">·</span>}
                  {task.model && (
                    <span className="text-[#8a6e5a] dark:text-[#d6b56d]">{task.model}</span>
                  )}
                  {task.effort && (
                    <>
                      <span className="text-[#c4b3a4] dark:text-[#584a3b]">·</span>
                      <span className="text-[#8a6e5a] dark:text-[#d6b56d]">⚡ {task.effort}</span>
                    </>
                  )}
                </div>
              )}
              </div>

              {/* 🌿 SUBTASKS SECTION */}
              {!task.parentId && (
                <div className="space-y-3.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5 font-sans">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                      <PawPrint size={13} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" /> Subtasks Breakdown ({subTasks.filter(s => s.status === 'done').length}/{subTasks.length})
                    </h4>
                    {onCreateTask && (
                      <button
                        type="button"
                        onClick={() => setIsAddingSubtask(true)}
                        className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] hover:bg-[#1a5b67] dark:bg-[#3c829e] dark:hover:bg-[#292119] text-[10px] font-extrabold px-3 py-1.5 rounded-xl flex items-center gap-1 transition-all cursor-pointer shadow-4xs font-sans tracking-wide active:scale-[0.98]"
                      >
                        <Plus size={11} /> Create Subtask Spec
                      </button>
                    )}
                  </div>

                  {subTasks.length > 0 && (
                    <div className="space-y-2.5">
                    {/* Visual progress bar */}
                    <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9]/65 dark:border-[#584a3b]/65 p-3 rounded-2xl flex items-center justify-between gap-4 shadow-3xs">
                      <div className="flex-1 bg-[#ede6dc]/60 dark:bg-[#292119]/60 rounded-full h-1.5 overflow-hidden">
                        <div 
                          className="bg-[#2a7a8a] dark:bg-[#d6b56d] dark:bg-[#e0a070] h-full rounded-full transition-all duration-300"
                          style={{ width: `${(subTasks.filter(s => s.status === 'done').length / subTasks.length) * 100}%` }}
                        />
                      </div>
                      <span className="text-[10px] font-mono font-black text-[#2a7a8a] dark:text-[#f3eadf]">
                        {Math.round((subTasks.filter(s => s.status === 'done').length / subTasks.length) * 100)}% complete
                      </span>
                    </div>

                    {/* Grid list (limited to 4) */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 select-none">
                      {(showAllSubtasks ? subTasks : subTasks.slice(0, 4)).map(sub => {
                        const subDone = sub.status === 'done';
                        const subInProgress = sub.status === 'in-progress';
                        return (
                          <div 
                            key={sub.id}
                            onClick={() => {
                              if (onSelectTask) onSelectTask(sub);
                            }}
                            className={`p-3.5 rounded-2xl border flex flex-col justify-between h-[90px] cursor-pointer transition-all hover:bg-[#fffcf8] dark:bg-[#292119] dark:hover:bg-[#1e1914] active:scale-[0.98] hover:shadow-sm relative ${
                              subDone 
                                ? 'bg-[#edf7ed]/30 dark:bg-[#292119]/30 border-emerald-100/50 text-gray-400 dark:text-[#b8ab9f]' 
                                : subInProgress
                                  ? 'bg-orange-50/15 border-[#e3a35a] dark:border-[#584a3b] shadow-2xs'
                                  : 'bg-white dark:bg-[#292119] border-[#ebdcb9]/65 dark:border-[#584a3b]/65 text-[#3a2f26] dark:text-[#f3eadf]'
                            }`}
                          >
                            <div className="space-y-1 min-w-0 pr-1">
                              <p className={`text-[11px] font-extrabold leading-snug truncate ${subDone ? 'line-through text-gray-400 dark:text-[#b8ab9f] font-normal' : 'text-[#3e3129] dark:text-[#f3eadf]'}`}>
                                {sub.title}
                              </p>
                              <button 
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const idToCopy = sub.displayId || sub.id;
                                  navigator.clipboard.writeText(idToCopy);
                                }}
                                className="flex items-center gap-1 text-[9px] font-mono text-gray-400 dark:text-[#b8ab9f]/80 hover:text-[#d89745] dark:text-[#d6b56d] dark:hover:text-[#e0a070] dark:text-[#d6b56d] font-bold cursor-pointer"
                                title="Copy Card ID"
                              >
                                ID: #{sub.displayId || sub.id}
                              </button>
                            </div>

                            <div className="flex items-center justify-between select-none font-mono text-[7.5px] font-bold">
                              {/* Agent & priority */}
                              <div className="flex items-center gap-1">
                                {sub.model && (
                                  <span className="px-1 py-0.2 rounded border bg-[#fae8ff] dark:bg-[#292119] text-[#86198f] dark:text-[#f3eadf] border-[#f5d0fe] dark:border-[#584a3b]">
                                    {sub.model}
                                  </span>
                                )}
                                <span className={`px-1 py-0.2 rounded border uppercase ${
                                  sub.priority === 'high' ? 'bg-[#ffdacf] dark:bg-[#292119] text-[#b43a20] dark:text-[#f3eadf] border-[#ffa995] dark:border-[#584a3b]' :
                                  sub.priority === 'medium' ? 'bg-[#ffecca] dark:bg-[#292119] text-[#a46c24] dark:text-[#f3eadf] border-[#f0cca3] dark:border-[#584a3b]' :
                                  'bg-[#e2f0dc] dark:bg-[#292119] text-[#4d7e35] dark:text-[#f3eadf] border-[#bddda4] dark:border-[#584a3b]'
                                }`}>
                                  {sub.priority}
                                </span>
                              </div>

                              {/* Status badge */}
                              <span className={`px-1.5 py-0.4 rounded-lg border uppercase font-extrabold ${
                                subDone ? 'bg-emerald-50 text-emerald-700 border-[#bddda4]/50 dark:border-[#584a3b]/50' :
                                subInProgress ? 'bg-orange-50 text-orange-700 border-orange-200/50' :
                                'bg-white dark:bg-[#292119] text-gray-400 dark:text-[#b8ab9f] border-gray-350'
                              }`}>
                                {sub.status === 'in-progress' ? 'active' : sub.status}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    {subTasks.length > 4 && !showAllSubtasks && (
                      <button
                        type="button"
                        onClick={() => setShowAllSubtasks(true)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show {subTasks.length - 4} more ↓
                      </button>
                    )}
                    {subTasks.length > 4 && showAllSubtasks && (
                      <button
                        type="button"
                        onClick={() => setShowAllSubtasks(false)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show less ↑
                      </button>
                    )}
                  </div>
                  )}
                </div>
              )}

              {/* 📂 TARGET FILES TO MODIFY SECTION */}
              <div className="space-y-2.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                  <FileCode size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Target Files (ไฟล์ที่แก้ไข)
                </h4>
                {task.targetFiles && task.targetFiles.length > 0 ? (
                  <div className="space-y-1.5">
                    {/* Show max 3 files, rest hidden until expanded */}
                    {(showAllFiles ? task.targetFiles : task.targetFiles.slice(0, 3)).map((f, i) => (
                      <div 
                        key={i} 
                        className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl p-2.5 flex items-center justify-between text-[11px] font-mono text-[#bd7e3e] dark:text-[#f3eadf] hover:border-[#dfa161] dark:border-[#e0a070] dark:hover:border-[#584a3b] group/file shadow-2xs"
                      >
                        <span className="truncate pr-2 font-semibold">{f}</span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(f);
                            setCopiedFile(f);
                            setTimeout(() => setCopiedFile(null), 2000);
                          }}
                          className={`px-2.5 py-1 rounded-xl text-[9px] transition-all cursor-pointer font-bold border ${
                            copiedFile === f
                              ? 'opacity-100 bg-[#7dad71] text-white border-[#7dad71] dark:border-[#8fce7c] dark:bg-[#584a3b] dark:text-[#f3eadf]'
                              : 'opacity-0 group-hover/file:opacity-100 text-[#856c5a] dark:text-[#f3eadf] hover:text-[#3a2010] dark:text-[#f3eadf] dark:hover:text-[#f3eadf] bg-[#fffbf6] dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b]'
                          }`}
                        >
                          {copiedFile === f ? 'copied!' : 'copy'}
                        </button>
                      </div>
                    ))}
                    {task.targetFiles.length > 3 && !showAllFiles && (
                      <button
                        type="button"
                        onClick={() => setShowAllFiles(true)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show {task.targetFiles.length - 3} more ↓
                      </button>
                    )}
                    {task.targetFiles.length > 3 && showAllFiles && (
                      <button
                        type="button"
                        onClick={() => setShowAllFiles(false)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show less ↑
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-[#a59182] dark:text-[#d6b56d] italic font-mono pl-1">No target files specified. Edit properties to add files.</p>
                )}
              </div>

              {/* Checklist steps SECTION */}
              <div className="space-y-2.5 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                  <CheckSquare size={13} className="text-[#728f44] dark:text-[#f3eadf]" /> Mini-Tasks (สิ่งที่ต้องทำ)
                </h4>
                {task.checklist && task.checklist.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <div className="flex flex-col">
                      {(showAllChecklist ? task.checklist : task.checklist.slice(0, 5)).map((item) => (
                        <div 
                          key={item.id || item.text}
                          onClick={() => handleToggleChecklistItem(item.id || item.text)}
                          className={`py-2 px-1 border-b last:border-b-0 border-[#ebdcb9]/40 dark:border-[#584a3b]/40 flex items-start gap-2.5 cursor-pointer transition-colors select-none ${
                            item.completed 
                              ? 'text-gray-400 dark:text-[#b8ab9f] line-through' 
                              : 'text-[#4d3d32] dark:text-[#f3eadf] hover:bg-[#f4ebd9] dark:bg-[#292119]/20 dark:hover:bg-[#3a2f26]/20'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={item.completed}
                            onChange={() => {}} // toggled on container click
                            className="mt-0.5 rounded border-[#ebdcb9] dark:border-[#584a3b] text-[#7dad71] dark:text-[#d6b56d] focus:ring-0 cursor-pointer pointer-events-none"
                          />
                          <span className="text-[11px] font-semibold select-none leading-relaxed">{item.text}</span>
                        </div>
                      ))}
                    </div>
                    {task.checklist.length > 5 && !showAllChecklist && (
                      <button
                        type="button"
                        onClick={() => setShowAllChecklist(true)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show {task.checklist.length - 5} more ↓
                      </button>
                    )}
                    {task.checklist.length > 5 && showAllChecklist && (
                      <button
                        type="button"
                        onClick={() => setShowAllChecklist(false)}
                        className="w-full text-center text-[10px] font-mono text-[#a47a32] dark:text-[#d6b56d] hover:text-[#8a6020] dark:hover:text-[#e0a070] font-bold transition-colors cursor-pointer pl-1"
                      >
                        show less ↑
                      </button>
                    )}
                  </div>
                ) : (
                  <p className="text-[10px] text-[#a59182] dark:text-[#d6b56d] italic font-mono pl-1 font-bold">No steps configured. Edit properties to define steps.</p>
                )}
              </div>

              {/* Links & References Accordion */}
              {((task.images && task.images.length > 0) || task.specUrl) && (
                <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                  <button
                    type="button"
                    onClick={(e) => handleAccordionClick(e, 'links')}
                    className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-[#bf8a50]/10 dark:bg-[#bf8a50]/20 flex items-center justify-center">
                        <LinkIcon size={12} className="text-[#bf8a50] dark:text-[#d6b56d]" />
                      </div>
                      <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Links & References</span>
                    </div>
                    <ChevronDown 
                      size={14} 
                      className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('links') ? 'rotate-180' : ''}`}
                    />
                  </button>
                  
                  {openSections.has('links') && (
                    <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 font-sans">
                        {task.images && task.images.length > 0 && (
                          <div className="space-y-2 col-span-1 md:col-span-2">
                            <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                              <ImageIcon size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Attached Images
                            </h4>
                            <div className="flex gap-2 overflow-x-auto pb-2 snap-x">
                              {task.images.map((img) => (
                                <div key={img.id} className="relative border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-white dark:bg-[#292119] shadow-xs p-1 shrink-0 w-64 snap-center group cursor-pointer" onClick={() => setViewingImage(img)}>
                                  <img 
                                    src={img.url} 
                                    alt={img.filename} 
                                    className="w-full h-48 object-cover rounded-xl hover:opacity-90 transition-opacity" 
                                    referrerPolicy="no-referrer"
                                  />
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {task.specUrl && (
                          <div className="space-y-2 flex flex-col justify-start">
                            <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
                              <LinkIcon size={13} className="text-[#3c829e] dark:text-[#f3eadf]" /> Verification Specification Sheet
                            </h4>
                            <div className="bg-[#fffdfa] dark:bg-[#292119] border border-[#ebdcb9]/60 dark:border-[#584a3b]/60 hover:border-[#ebdcb9] dark:border-[#584a3b] dark:hover:border-[#584a3b] p-4 rounded-2xl shadow-2xs flex flex-col gap-2.5 h-full relative justify-center">
                              <div className="flex items-center gap-2">
                                <div className="p-2 bg-[#e4eff3] dark:bg-[#292119] rounded-xl text-[#3c829e] dark:text-[#f3eadf]">
                                  <LinkIcon size={16} />
                                </div>
                                <div className="min-w-0 flex-1">
                                  <p className="text-[11px] font-bold text-[#354f59] dark:text-[#f3eadf] tracking-tight truncate max-w-full">
                                    {task.specUrl}
                                  </p>
                                  <p className="text-[9px] text-[#6d848c] dark:text-[#f3eadf] font-mono leading-tight">Click link below to browse the specification workspace</p>
                                </div>
                              </div>
                              <a 
                                href={task.specUrl.startsWith('http') ? task.specUrl : `https://${task.specUrl}`} 
                                target="_blank" 
                                rel="noreferrer" 
                                className="w-full bg-[#3c829e] dark:bg-[#e0a070] hover:bg-[#2e6d87] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] text-center text-[10px] font-extrabold py-2 rounded-xl transition-all block cursor-pointer uppercase tracking-widest mt-1"
                              >
                                OPEN EXTERNAL SPEC SHEET ↗
                              </a>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}



              {/* Detailed specification display */}
              {task.description && (
                <div className="space-y-2 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
                  <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 mb-3 font-bold">
                    <AlignLeft size={13} className="text-[#bf8a50] dark:text-[#d6b56d]" /> Specifications Instruction sheet
                  </h4>
                  <div className="bg-[#ffffff] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl p-4 text-[11px] font-mono text-[#5c493c] dark:text-[#f3eadf] leading-relaxed overflow-x-auto shadow-2xs prose max-w-none select-text dark:prose-invert dark:prose-headings:text-[#e0a070] dark:text-[#d6b56d]">
                    <MarkdownRenderer content={task.description} />
                  </div>
                </div>
              )}

              {/* QA Context Accordion */}
              {(task.acceptanceCriteria || task.verification) && (
                <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                  <button
                    type="button"
                    onClick={(e) => handleAccordionClick(e, 'qa')}
                    className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-[#7dad71]/10 dark:bg-[#7dad71]/20 flex items-center justify-center">
                        <FlaskConical size={12} className="text-[#7dad71] dark:text-[#d6b56d]" />
                      </div>
                      <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">QA Context</span>
                    </div>
                    <ChevronDown 
                      size={14} 
                      className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('qa') ? 'rotate-180' : ''}`}
                    />
                  </button>
                  
                  {openSections.has('qa') && (
                    <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                      <div className="grid grid-cols-1 gap-5 font-mono text-[10.5px]">
                        {task.acceptanceCriteria && (
                          <div className="space-y-1.5">
                            <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Acceptance Criteria</strong>
                            <p className="text-[#5c493c] dark:text-[#f3eadf] leading-relaxed whitespace-pre-wrap">{task.acceptanceCriteria}</p>
                          </div>
                        )}
                        {task.verification && (
                          <div className="space-y-1.5">
                            <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Verification Steps</strong>
                            <p className="text-[#5c493c] dark:text-[#f3eadf] leading-relaxed whitespace-pre-wrap">{task.verification}</p>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Dev Context Accordion */}
              {(task.reasoning || task.repoContext || task.jiraKey || task.repo || task.sourceUrl) && (
                <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
                  <button
                    type="button"
                    onClick={(e) => handleAccordionClick(e, 'dev')}
                    className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-2">
                      <div className="w-6 h-6 rounded-lg bg-[#3c829e]/10 dark:bg-[#3c829e]/20 flex items-center justify-center">
                        <Code2 size={12} className="text-[#3c829e] dark:text-[#d6b56d]" />
                      </div>
                      <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Dev Context</span>
                    </div>
                    <ChevronDown 
                      size={14} 
                      className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('dev') ? 'rotate-180' : ''}`}
                    />
                  </button>
                  
                  {openSections.has('dev') && (
                    <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-4">
                      <div className="flex flex-col gap-5 font-mono text-[10.5px]">
                        {task.reasoning && (
                          <div className="space-y-1.5">
                            <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Reasoning & Context</strong>
                            <p className="text-[#5c493c] dark:text-[#f3eadf] leading-relaxed whitespace-pre-wrap">{task.reasoning}</p>
                          </div>
                        )}
                        {task.repoContext && (
                          <div className="space-y-1.5">
                            <strong className="block text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest font-extrabold text-[9px]">Repository Context</strong>
                            <p className="text-[#5c493c] dark:text-[#f3eadf] leading-relaxed whitespace-pre-wrap">{task.repoContext}</p>
                          </div>
                        )}
                        {/* Inline Metadata (Jira/Repo/SourceUrl) */}
                        {(task.jiraKey || task.repo || task.sourceUrl) && (
                          <div className="flex flex-wrap gap-3">
                            {task.jiraKey && (
                              <div className="bg-[#e4eff3] dark:bg-[#292119] text-[#354f59] dark:text-[#f3eadf] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5">
                                <span className="text-[9px] uppercase tracking-wider opacity-80">Jira Key:</span> {task.jiraKey}
                              </div>
                            )}
                            {task.repo && (
                              <div className="bg-[#fffdfa] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] text-[#8a6e5a] dark:text-[#f3eadf] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5">
                                <span className="text-[9px] uppercase tracking-wider">Repo:</span> {task.repo}
                              </div>
                            )}
                            {task.sourceUrl && (
                              <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="bg-[#fffdfa] dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] text-[#3c829e] dark:text-[#f3eadf] hover:text-[#2a7a8a] dark:hover:text-[#f3eadf] px-2.5 py-1 rounded-lg shadow-2xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer">
                                <span className="text-[9px] uppercase tracking-wider">Source URL ↗</span>
                              </a>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Activity Logs */}
          <div className="border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl overflow-hidden bg-[#fffdfa] dark:bg-[#292119]">
            <button
              type="button"
              onClick={(e) => handleAccordionClick(e, 'activity')}
              className="w-full flex items-center justify-between p-3.5 hover:bg-[#f4ebd9] dark:bg-[#292119]/30 dark:hover:bg-[#3a2f26]/30 transition-colors cursor-pointer"
            >
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-[#e5a93b]/10 dark:bg-[#e5a93b]/20 flex items-center justify-center">
                  <Activity size={12} className="text-[#e5a93b] dark:text-[#d6b56d]" />
                </div>
                <span className="text-xs font-bold text-[#5c493c] dark:text-[#f3eadf]">Activity & Logs</span>
                <span className="px-1.5 py-0.5 rounded-md bg-[#f4ebd9] dark:bg-[#3a2f26] text-[9px] font-mono font-bold text-[#8a6e5a] dark:text-[#b8ab9f]">
                  {task.logs.length}
                </span>
              </div>
              <ChevronDown 
                size={14} 
                className={`text-[#c4b3a4] dark:text-[#8a7a6a] transition-transform duration-200 ${openSections.has('activity') ? 'rotate-180' : ''}`}
              />
            </button>
            
            {openSections.has('activity') && (
              <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7]/50 dark:bg-[#292119]/50 p-0">
                {/* Tabs Header */}
                <div className="flex items-center gap-4 px-4 pt-3 border-b border-[#ebdcb9]/40 dark:border-[#584a3b]/40">
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('notes')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'notes' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    Notes ({task.logs.filter(l => l.type === 'comment').length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('autowork')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'autowork' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    Auto-Work
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveLogTab('history')}
                    className={`pb-2 text-[10px] font-mono font-bold uppercase tracking-wider transition-colors border-b-2 cursor-pointer ${
                      activeLogTab === 'history' 
                        ? 'text-[#d89745] dark:text-[#d6b56d] border-[#d89745] dark:border-[#d6b56d]' 
                        : 'text-[#a59182] dark:text-[#8a7a6a] border-transparent hover:text-[#5c493c] dark:hover:text-[#f3eadf]'
                    }`}
                  >
                    History ({task.logs.filter(l => l.type !== 'comment').length})
                  </button>
                </div>

                <div className="p-4 space-y-4">
                  {/* NOTES TAB */}
                  {activeLogTab === 'notes' && (
                    <>
                      <div className="space-y-2 max-h-96 overflow-y-auto pr-1 scrollbar-thin">
                        {[...task.logs]
                          .filter(log => log.type === 'comment')
                          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                          .map((log) => (
                            <div 
                              key={log.id} 
                              className="p-3 rounded-xl border flex flex-col gap-1 text-[10px] font-mono leading-relaxed shadow-3xs transition-all bg-[#fffdfa] dark:bg-[#292119] border-[#ebdcb9] dark:border-[#584a3b] text-[#55453B] dark:text-[#f3eadf]"
                            >
                              <div className="flex justify-between items-center text-[8px] text-[#a08b7e] dark:text-[#d6b56d] font-extrabold uppercase mb-1">
                                <span className="flex items-center gap-1 text-[#d89745] dark:text-[#d6b56d]">
                                  <Clipboard size={10} />
                                  Note
                                </span>
                                <span>{new Date(log.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}</span>
                              </div>
                              <p className="whitespace-pre-wrap">{log.message.replace(/^💬 Note: /, '')}</p>
                            </div>
                          ))}
                        {task.logs.filter(l => l.type === 'comment').length === 0 && (
                          <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                            No notes yet. Add one below.
                          </div>
                        )}
                      </div>
                      
                      <form onSubmit={handleAddComment} className="flex gap-2 font-mono mt-2">
                        <input
                          type="text"
                          className="flex-1 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3.5 py-2 text-xs text-[#534135] dark:text-[#f3eadf] placeholder-[#c4b3a4] outline-none focus:border-[#d4994e] dark:border-[#e0a070] dark:focus:border-[#584a3b] font-mono shadow-2xs"
                          placeholder="Write a note or comment..."
                          value={newComment}
                          onChange={(e) => setNewComment(e.target.value)}
                        />
                        <button
                          type="submit"
                          className="bg-[#fff9ee] dark:bg-[#292119] hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#584a3b] text-[#856b5a] dark:text-[#f3eadf] border border-[#ebdcb9] dark:border-[#584a3b] px-4 rounded-xl flex items-center justify-center cursor-pointer transition-colors hover:shadow-2xs"
                          title="Add Note"
                        >
                          <Plus size={15} />
                        </button>
                      </form>
                    </>
                  )}

                  {/* AUTO-WORK TAB */}
                  {activeLogTab === 'autowork' && (
                    <div className="space-y-4">
                      {latestRun ? (
                        <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl p-3 space-y-2 shadow-2xs">
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold">
                                Latest Auto Work Status
                              </div>
                              <div className="text-[12px] font-bold text-[#5c493c] dark:text-[#f3eadf]">
                                {autoWorkState?.label || latestRun.status}
                              </div>
                            </div>
                            {canRetryLatestRun && (
                              <button
                                type="button"
                                onClick={handleRetryLatestRun}
                                disabled={isRetryingRun}
                                className="px-3 py-1.5 rounded-xl bg-[#3c829e] dark:bg-[#e0a070] text-white dark:text-[#292119] text-[10px] font-mono font-extrabold hover:bg-[#2e6d87] dark:hover:bg-[#d6b56d] transition-colors cursor-pointer disabled:opacity-60"
                              >
                                {isRetryingRun ? 'Retrying...' : 'Retry Run'}
                              </button>
                            )}
                          </div>
                          {latestRun.errorMessage && (
                            <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#d6b56d] break-words">
                              {latestRun.errorMessage}
                            </div>
                          )}
                          {autoWorkState?.message && autoWorkState.message !== latestRun.errorMessage && (
                            <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#d6b56d] break-words">
                              {autoWorkState.message}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                          No auto-work runs initiated for this task yet.
                        </div>
                      )}

                      <div className="bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-2xl p-3 space-y-2 shadow-2xs">
                        <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold">
                          Final Output
                        </div>
                        {latestRunLogLoading && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            Loading captured run log…
                          </div>
                        )}
                        {!latestRunLogLoading && latestRunLogError && (
                          <div className="text-[10px] font-mono text-[#b4432d] dark:text-[#f3eadf] break-words">
                            {latestRunLogError}
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && !latestRun && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            No run log yet.
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && latestRun && !latestRunLogExists && (
                          <div className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
                            No captured run log yet.
                          </div>
                        )}
                        {!latestRunLogLoading && !latestRunLogError && latestRunLogExists && (
                          <pre className="max-h-64 overflow-auto rounded-xl bg-[#f7f3ea] dark:bg-[#14110d] p-3 text-[10px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[#45372d] dark:text-[#f3eadf]">
                            {latestRunLogTail || '(empty log)'}
                          </pre>
                        )}
                      </div>

                      {runHistoryFiles && (
                        <div className="space-y-2">
                          <div className="text-[10px] font-mono uppercase tracking-widest text-[#8a6e5a] dark:text-[#f3eadf] font-extrabold px-1">
                            Run History Files
                          </div>
                          <div className="grid grid-cols-1 gap-2">
                            {[
                              ['Run Folder', runHistoryFiles.runDir],
                              ['Prompt', runHistoryFiles.promptPath],
                              ['Launch', runHistoryFiles.launchMetadataPath],
                              ['Summary', runHistoryFiles.outputSummaryPath],
                              ['Result', runHistoryFiles.resultPath],
                              ['Log', runHistoryFiles.logPath],
                            ].map(([label, pathValue]) => (
                              <button
                                key={label}
                                type="button"
                                onClick={() => {
                                  if (label === 'Log' && onShowLog && task.latestAgentRun) {
                                    onShowLog({ id: task.latestAgentRun.id, status: task.latestAgentRun.status, agent: task.agent, model: task.model });
                                  } else {
                                    handleCopyHistoryPath(pathValue);
                                  }
                                }}
                                className="w-full text-left bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] rounded-xl px-3 py-2 hover:bg-[#fffcf6] dark:hover:bg-[#1e1914] transition-colors cursor-pointer shadow-2xs group"
                              >
                                <div className="flex items-center justify-between gap-3">
                                  <span className="text-[9px] font-mono uppercase text-[#8a6e5a] dark:text-[#d6b56d] font-extrabold">{label}</span>
                                  <span className={`text-[9px] font-mono font-bold ${label === 'Log' ? 'text-blue-500 dark:text-[#8ba4e8]' : 'text-emerald-600 dark:text-[#e0a070] opacity-0 group-hover:opacity-100 transition-opacity'}`}>
                                    {label === 'Log' ? 'view log' : copiedHistoryPath === pathValue ? 'copied' : 'copy path'}
                                  </span>
                                </div>
                                <div className="mt-1 text-[10px] font-mono text-[#5c493c] dark:text-[#f3eadf] break-all truncate">
                                  {pathValue}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* HISTORY TAB */}
                  {activeLogTab === 'history' && (
                    <div className="space-y-0 relative before:absolute before:inset-0 before:left-[12px] before:h-full before:w-px before:bg-gradient-to-b before:from-transparent before:via-[#ebdcb9] dark:before:via-[#584a3b] before:to-transparent max-h-96 overflow-y-auto pr-1 scrollbar-thin">
                      {[...task.logs]
                        .filter(log => log.type !== 'comment')
                        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                        .map((log) => (
                          <div 
                            key={log.id} 
                            className="relative flex items-start gap-3 py-2"
                          >
                            <div className={`w-2 h-2 mt-1.5 rounded-full ring-4 ring-[#fdfbf7] dark:ring-[#292119]/50 shrink-0 z-10 ml-[8px] ${
                                log.type === 'create' ? 'bg-[#7dad71] dark:bg-[#a3c773]' :
                                log.type === 'move' ? 'bg-[#d89745] dark:bg-[#d6b56d]' :
                                'bg-[#8a6e5a] dark:bg-[#b8ab9f]'
                              }`} 
                            />
                            
                            <div className="flex-1 flex flex-col min-w-0 pr-2">
                              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-0.5">
                                <span className="text-[9px] font-mono font-bold uppercase tracking-widest text-[#5c493c] dark:text-[#f3eadf]">
                                  {log.type}
                                </span>
                                <span className="text-[8px] font-mono text-[#c4b3a4] dark:text-[#8a7a6a]">
                                  {new Date(log.timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                </span>
                              </div>
                              <p className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f] leading-snug break-words">
                                {log.message}
                              </p>
                            </div>
                          </div>
                        ))}
                      {task.logs.filter(l => l.type !== 'comment').length === 0 && (
                        <div className="text-center py-4 text-[10px] font-mono text-[#a59182] dark:text-[#8a7a6a]">
                          No system history available.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Footer actions */}
        <div className="p-4 bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 border-t border-[#ebdcb9] dark:border-[#584a3b] flex justify-end gap-3 text-xs font-mono">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 bg-white dark:bg-[#292119] border border-[#ebdcb9] dark:border-[#584a3b] text-[#6d5a4d] dark:text-[#f3eadf] hover:bg-[#fffcf6] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] rounded-xl font-bold font-mono transition-colors cursor-pointer shadow-3xs"
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
