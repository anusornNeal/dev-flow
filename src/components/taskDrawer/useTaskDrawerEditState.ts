import type React from 'react';
import { useEffect, useState } from 'react';
import type { ChecklistItem, LogEntry, Task, TaskCategory, TaskImage, TaskPriority, TaskStatus } from '../../types';

interface UseTaskDrawerEditStateInput {
  task: Task;
  onUpdate: (updatedTask: Task) => void;
}

export function useTaskDrawerEditState({ task, onUpdate }: UseTaskDrawerEditStateInput) {
  const [isEditing, setIsEditing] = useState(false);
  const [editedTitle, setEditedTitle] = useState(task.title);
  const [editedDesc, setEditedDesc] = useState(task.description);
  const [editedBranch, setEditedBranch] = useState(task.branch || '');
  const [editedPriority, setEditedPriority] = useState<TaskPriority>(task.priority);
  const [editedCategory, setEditedCategory] = useState<TaskCategory>(task.category || 'general');
  const [editedStatus, setEditedStatus] = useState<TaskStatus>(task.status);
  const [editedFilesList, setEditedFilesList] = useState<string[]>(task.targetFiles || []);
  const [editedChecklistList, setEditedChecklistList] = useState<string[]>((task.checklist || []).map((c) => c.text));
  const [editedImages, setEditedImages] = useState<TaskImage[]>(task.images || []);
  const [editedSpecUrl, setEditedSpecUrl] = useState(task.specUrl || '');
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

  useEffect(() => {
    if (!isEditing) {
      setEditedTitle(task.title);
      setEditedDesc(task.description);
      setEditedBranch(task.branch || '');
      setEditedPriority(task.priority);
      setEditedCategory(task.category || 'general');
      setEditedStatus(task.status);
      setEditedFilesList(task.targetFiles || []);
      setEditedChecklistList((task.checklist || []).map((c) => c.text));
      setEditedImages(task.images || []);
      setEditedSpecUrl(task.specUrl || '');
      setEditedAgent(task.agent || '');
      setEditedModel(task.model || '');
      setEditedEffort(task.effort || '');
    }
  }, [task, isEditing]);

  const uploadImage = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/images/upload', {
        method: 'POST',
        body: formData,
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

  const handleSave = () => {
    if (!editedTitle.trim()) return;

    const filesArray = editedFilesList
      .map((f) => f.trim())
      .filter((f) => f.length > 0);

    const checklistLines = editedChecklistList
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const parsedChecklist: ChecklistItem[] = checklistLines.map((line, idx) => {
      const existing = (task.checklist || []).find((c) => c.text === line);
      return {
        id: existing?.id || `step-${Date.now()}-${idx}`,
        text: line,
        completed: existing?.completed || false,
      };
    });

    const newLogs: LogEntry[] = [...task.logs];

    if (editedStatus !== task.status) {
      newLogs.push({
        id: `log-${Date.now()}-status`,
        timestamp: new Date().toISOString(),
        message: `Status moved from ${task.status.toUpperCase()} to ${editedStatus.toUpperCase()}`,
        type: 'move',
      });
    }

    if (editedBranch !== (task.branch || '')) {
      newLogs.push({
        id: `log-${Date.now()}-branch`,
        timestamp: new Date().toISOString(),
        message: editedBranch
          ? `Branch checkout updated to: ${editedBranch}`
          : 'Removed active git branch',
        type: 'edit',
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
      tags: task.tags || [],
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
      logs: newLogs,
    };

    onUpdate(updatedTask);
    setIsEditing(false);
  };

  return {
    isEditing,
    setIsEditing,
    editedTitle,
    setEditedTitle,
    editedDesc,
    setEditedDesc,
    editedBranch,
    setEditedBranch,
    editedPriority,
    setEditedPriority,
    editedCategory,
    setEditedCategory,
    editedStatus,
    setEditedStatus,
    editedFilesList,
    setEditedFilesList,
    editedChecklistList,
    setEditedChecklistList,
    editedImages,
    setEditedImages,
    editedSpecUrl,
    setEditedSpecUrl,
    editedAgent,
    setEditedAgent,
    editedModel,
    setEditedModel,
    editedEffort,
    setEditedEffort,
    editedReasoning,
    setEditedReasoning,
    editedAcceptance,
    setEditedAcceptance,
    editedVerification,
    setEditedVerification,
    editedRepoContext,
    setEditedRepoContext,
    editedJiraKey,
    setEditedJiraKey,
    editedRepo,
    setEditedRepo,
    editedSourceUrl,
    setEditedSourceUrl,
    uploadImage,
    handlePasteImage,
    handleSave,
  };
}
