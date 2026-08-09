/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type { LogEntry, Task, TaskImage } from '../types';
import CreateTaskModal from './CreateTaskModal';
import ImageViewer from './ImageViewer';
import { useTaskDrawerViewModel } from '../viewModels/useTaskDrawerViewModel';
import { useDrawerDisclosure } from './taskDrawer/useDrawerDisclosure';
import { useRunArtifacts } from './taskDrawer/useRunArtifacts';
import { useTaskDrawerEditState } from './taskDrawer/useTaskDrawerEditState';
import TaskInspectorShell, { type TaskInspectorTab } from './taskDrawer/TaskInspectorShell';
import TaskOverviewTab from './taskDrawer/TaskOverviewTab';
import TaskWorkTab from './taskDrawer/TaskWorkTab';
import TaskInspectorActivityTab from './taskDrawer/TaskInspectorActivityTab';
import BugThreadsSection from './taskDrawer/BugThreadsSection';
import SubtasksSection from './taskDrawer/SubtasksSection';

interface TaskDetailsDrawerProps {
  task: Task;
  allTasks?: Task[];
  initialTab?: TaskInspectorTab;
  onSelectTask?: (task: Task) => void;
  onClose: () => void;
  onUpdate: (updatedTask: Task) => void;
  onDelete: (id: string) => void;
  onCreateTask?: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => Promise<void>;
  onShowLog?: (run: { id: string; status?: string; agent?: string | null; model?: string | null }) => void;
}

export default function TaskDetailsDrawer({
  task: initialTask,
  allTasks = [],
  initialTab = 'overview',
  onSelectTask,
  onClose,
  onUpdate,
  onDelete,
  onCreateTask,
  onShowLog,
}: TaskDetailsDrawerProps) {
  const drawerViewModel = useTaskDrawerViewModel();
  const [activeTab, setActiveTab] = useState<TaskInspectorTab>(initialTab);
  const [viewingImage, setViewingImage] = useState<TaskImage | null>(null);
  const [newComment, setNewComment] = useState('');
  const [copiedHistoryPath, setCopiedHistoryPath] = useState<string | null>(null);
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [isRetryingRun, setIsRetryingRun] = useState(false);

  useEffect(() => {
    if (drawerViewModel.task?.id !== initialTask.id) void drawerViewModel.open(initialTask.id);
    setActiveTab(initialTab);
  }, [initialTask.id, initialTab]);

  const task = {
    description: '',
    tags: [],
    logs: [],
    images: [],
    ...((drawerViewModel.task as unknown as Partial<Task>) || {}),
    ...initialTask,
  } as Task;

  const parentTask = task.parentId ? allTasks.find((candidate) => candidate.id === task.parentId) : undefined;
  const subTasks = allTasks.filter((candidate) => candidate.parentId === task.id);
  const disclosure = useDrawerDisclosure(task.id);
  const edit = useTaskDrawerEditState({ task, onUpdate });
  const runArtifacts = useRunArtifacts(task);
  const latestRun = task.latestAgentRun;
  const canRetryLatestRun = Boolean(latestRun && !task.activeAgent && ['failed', 'cancelled'].includes(latestRun.status));

  const handleToggleChecklistItem = (itemIdentifier: string) => {
    drawerViewModel.toggleChecklist(itemIdentifier);
    const currentItem = (task.checklist || []).find((item) => (item.id || item.text) === itemIdentifier);
    const updatedTask: Task = {
      ...task,
      checklist: (task.checklist || []).map((item) => ((item.id || item.text) === itemIdentifier ? { ...item, completed: !item.completed } : item)),
      logs: [
        ...(task.logs || []),
        {
          id: `log-cl-${Date.now()}`,
          timestamp: new Date().toISOString(),
          message: `✓ Checklist item "${currentItem?.text || ''}" toggled to ${currentItem?.completed ? 'INCOMPLETE' : 'COMPLETED'}`,
          type: 'edit',
        },
      ],
      updatedAt: new Date().toISOString(),
    };
    onUpdate(updatedTask);
  };

  const handleAddComment = (event: React.FormEvent) => {
    event.preventDefault();
    const message = newComment.trim();
    if (!message) return;
    const log: LogEntry = {
      id: `log-comment-${Date.now()}`,
      timestamp: new Date().toISOString(),
      message: `💬 Note: ${message}`,
      type: 'comment',
    };
    onUpdate({ ...task, logs: [...(task.logs || []), log], updatedAt: new Date().toISOString() });
    setNewComment('');
  };

  const handleCopyHistoryPath = (pathValue: string) => {
    void navigator.clipboard?.writeText(pathValue);
    setCopiedHistoryPath(pathValue);
    window.setTimeout(() => setCopiedHistoryPath(null), 1800);
  };

  const handleRetryLatestRun = async () => {
    if (!latestRun || isRetryingRun) return;
    setIsRetryingRun(true);
    try {
      const response = await fetch(`/api/tasks/${task.id}/agent-runs/retry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error || `Retry failed with status ${response.status}`);
      if (body?.task) onUpdate(body.task);
    } catch (error) {
      console.error('Failed to retry latest run:', error);
    } finally {
      setIsRetryingRun(false);
    }
  };

  const overviewTab = (
    <TaskOverviewTab
      task={task}
      isEditing={edit.isEditing}
      editedTitle={edit.editedTitle}
      setEditedTitle={edit.setEditedTitle}
      editedDesc={edit.editedDesc}
      setEditedDesc={edit.setEditedDesc}
      editedStatus={edit.editedStatus}
      setEditedStatus={edit.setEditedStatus}
      editedPriority={edit.editedPriority}
      setEditedPriority={edit.setEditedPriority}
      editedCategory={edit.editedCategory}
      setEditedCategory={edit.setEditedCategory}
      editedAcceptance={edit.editedAcceptance}
      setEditedAcceptance={edit.setEditedAcceptance}
      editedReasoning={edit.editedReasoning}
      setEditedReasoning={edit.setEditedReasoning}
      editedRepoContext={edit.editedRepoContext}
      setEditedRepoContext={edit.setEditedRepoContext}
      editedSpecUrl={edit.editedSpecUrl}
      setEditedSpecUrl={edit.setEditedSpecUrl}
      editedRepo={edit.editedRepo}
      setEditedRepo={edit.setEditedRepo}
      editedJiraKey={edit.editedJiraKey}
      setEditedJiraKey={edit.setEditedJiraKey}
      editedSourceUrl={edit.editedSourceUrl}
      setEditedSourceUrl={edit.setEditedSourceUrl}
      editedImages={edit.editedImages}
      setEditedImages={edit.setEditedImages}
      uploadImage={edit.uploadImage}
      onViewImage={setViewingImage}
    />
  );

  const workTab = (
    <TaskWorkTab
      task={task}
      isEditing={edit.isEditing}
      editedBranch={edit.editedBranch}
      setEditedBranch={edit.setEditedBranch}
      editedFilesList={edit.editedFilesList}
      setEditedFilesList={edit.setEditedFilesList}
      editedChecklistList={edit.editedChecklistList}
      setEditedChecklistList={edit.setEditedChecklistList}
      editedAgent={edit.editedAgent}
      setEditedAgent={edit.setEditedAgent}
      editedModel={edit.editedModel}
      setEditedModel={edit.setEditedModel}
      editedEffort={edit.editedEffort}
      setEditedEffort={edit.setEditedEffort}
      editedVerification={edit.editedVerification}
      setEditedVerification={edit.setEditedVerification}
      onToggleChecklistItem={handleToggleChecklistItem}
    />
  );

  const subtasksTab = (
    <div className="mx-auto max-w-6xl">
      <SubtasksSection
        task={task}
        subTasks={subTasks}
        showAllSubtasks={disclosure.showAllSubtasks}
        canCreateSubtask={Boolean(onCreateTask) && !task.parentId}
        onCreateSubtask={() => setIsAddingSubtask(true)}
        onSelectTask={onSelectTask}
        onShowAllSubtasksChange={disclosure.setShowAllSubtasks}
      />
    </div>
  );

  const activityTab = (
    <TaskInspectorActivityTab
      task={task}
      newComment={newComment}
      setNewComment={setNewComment}
      onAddComment={handleAddComment}
      canRetryLatestRun={canRetryLatestRun}
      isRetryingRun={isRetryingRun}
      onRetryLatestRun={handleRetryLatestRun}
      latestRunLogLoading={runArtifacts.latestRunLogLoading}
      latestRunLogError={runArtifacts.latestRunLogError}
      latestRunLogExists={runArtifacts.latestRunLogExists}
      latestRunLogTail={runArtifacts.latestRunLogTail}
      runHistoryFiles={runArtifacts.runHistoryFiles}
      copiedHistoryPath={copiedHistoryPath}
      onCopyHistoryPath={handleCopyHistoryPath}
      onShowLog={onShowLog}
    />
  );

  const content = activeTab === 'overview'
    ? overviewTab
    : activeTab === 'work'
      ? workTab
      : activeTab === 'subtasks'
        ? subtasksTab
        : activeTab === 'bugs'
          ? <div className="mx-auto max-w-6xl"><BugThreadsSection task={task} bugs={task.bugs} onTaskUpdated={onUpdate} /></div>
          : activityTab;

  return (
    <div onPaste={edit.handlePasteImage}>
      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />
      <TaskInspectorShell
        task={task}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        onClose={onClose}
        onDelete={() => onDelete(task.id)}
        isEditing={edit.isEditing}
        onToggleEdit={() => edit.setIsEditing((value) => !value)}
        onSave={edit.handleSave}
        onDiscard={() => edit.setIsEditing(false)}
      >
        {parentTask && (
          <div className="mx-auto mb-5 flex max-w-6xl flex-wrap items-center justify-between gap-3 rounded-2xl border border-[#d8cabb] bg-[#f5efe7] px-4 py-3 dark:border-[#584a3b] dark:bg-[#292119]">
            <div className="min-w-0">
              <p className="text-[10px] font-black uppercase tracking-[0.1em] text-[#9a6a34] dark:text-[#e0a070]">Parent task</p>
              <p className="truncate text-[13px] font-bold text-[#594638] dark:text-[#f1e7de]">{parentTask.displayId || parentTask.id} · {parentTask.title}</p>
            </div>
            {onSelectTask && <button type="button" onClick={() => onSelectTask(parentTask)} className="rounded-lg border border-[#d9c5aa] bg-white px-3 py-2 text-[11px] font-extrabold text-[#7c5d42] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#eadfd5]">Open parent</button>}
          </div>
        )}
        {content}
      </TaskInspectorShell>

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
