/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
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
import {
  createTaskUiEvidenceRequestGate,
  getTaskUiEvidence,
  type TaskUiEvidencePage,
} from '../client/uiPreviewClient';

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
  const [activeTab, setActiveTab] = useState<TaskInspectorTab>(() => (
    initialTab === 'subtasks' && !allTasks.some((candidate) => candidate.parentId === initialTask.id)
      ? 'overview'
      : initialTab
  ));
  const [viewingImage, setViewingImage] = useState<TaskImage | null>(null);
  const [newComment, setNewComment] = useState('');
  const [copiedHistoryPath, setCopiedHistoryPath] = useState<string | null>(null);
  const [isAddingSubtask, setIsAddingSubtask] = useState(false);
  const [isRetryingRun, setIsRetryingRun] = useState(false);
  const [uiEvidencePage, setUiEvidencePage] = useState<TaskUiEvidencePage>({ items: [], nextCursor: null, limit: 20 });
  const [uiEvidenceLoading, setUiEvidenceLoading] = useState(false);
  const [uiEvidenceLoadingMore, setUiEvidenceLoadingMore] = useState(false);
  const [uiEvidenceError, setUiEvidenceError] = useState<string | null>(null);
  const uiEvidenceGateRef = useRef(createTaskUiEvidenceRequestGate());

  const refreshUiEvidence = useCallback(async ({ cursor = null, append = false }: { cursor?: string | null; append?: boolean } = {}) => {
    const token = uiEvidenceGateRef.current.begin(initialTask.id);
    if (append) {
      setUiEvidenceLoadingMore(true);
    } else {
      setUiEvidenceLoading(true);
      setUiEvidenceError(null);
    }
    try {
      const page = await getTaskUiEvidence(initialTask.id, { cursor, limit: 20 });
      if (!uiEvidenceGateRef.current.isCurrent(token)) return;
      setUiEvidencePage((current) => {
        if (!append) return page;
        const seen = new Set<string>();
        const items = [...current.items, ...page.items].filter((item) => {
          const key = item.evidenceId || `${item.previewId}:${item.frozenRevision}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        return { items, nextCursor: page.nextCursor, limit: page.limit };
      });
      setUiEvidenceError(null);
    } catch (error) {
      if (!uiEvidenceGateRef.current.isCurrent(token)) return;
      setUiEvidenceError(error instanceof Error ? error.message : String(error));
    } finally {
      if (uiEvidenceGateRef.current.isCurrent(token)) {
        setUiEvidenceLoading(false);
        setUiEvidenceLoadingMore(false);
      }
    }
  }, [initialTask.id]);

  useEffect(() => {
    if (drawerViewModel.task?.id !== initialTask.id) void drawerViewModel.open(initialTask.id);
    setActiveTab(initialTab === 'subtasks' && !allTasks.some((candidate) => candidate.parentId === initialTask.id) ? 'overview' : initialTab);
  }, [initialTask.id, initialTab]);

  useEffect(() => {
    uiEvidenceGateRef.current.invalidate();
    setUiEvidencePage({ items: [], nextCursor: null, limit: 20 });
    setUiEvidenceError(null);
    void refreshUiEvidence();
    return () => uiEvidenceGateRef.current.invalidate();
  }, [initialTask.id, refreshUiEvidence]);

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
  const hasSubtasks = subTasks.length > 0;
  const disclosure = useDrawerDisclosure(task.id);
  const edit = useTaskDrawerEditState({ task, onUpdate });
  const runArtifacts = useRunArtifacts(task);
  const latestRun = task.latestAgentRun;
  const canRetryLatestRun = Boolean(latestRun && !task.activeAgent && ['failed', 'cancelled'].includes(latestRun.status));

  useEffect(() => {
    if (!hasSubtasks && activeTab === 'subtasks') setActiveTab('overview');
  }, [activeTab, hasSubtasks]);

  const handleClose = () => {
    uiEvidenceGateRef.current.invalidate();
    onClose();
  };

  const handleLoadMoreUiEvidence = () => {
    if (!uiEvidencePage.nextCursor || uiEvidenceLoadingMore) return;
    void refreshUiEvidence({ cursor: uiEvidencePage.nextCursor, append: true });
  };

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
      uiEvidence={uiEvidencePage.items}
      uiEvidenceLoading={uiEvidenceLoading}
      uiEvidenceLoadingMore={uiEvidenceLoadingMore}
      uiEvidenceError={uiEvidenceError}
      uiEvidenceNextCursor={uiEvidencePage.nextCursor}
      onRefreshUiEvidence={() => { void refreshUiEvidence(); }}
      onLoadMoreUiEvidence={handleLoadMoreUiEvidence}
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
        canCreateSubtask={Boolean(onCreateTask) && !task.parentId}
        onCreateSubtask={() => setIsAddingSubtask(true)}
        onSelectTask={onSelectTask}
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
        showSubtasks={hasSubtasks}
        onTabChange={setActiveTab}
        onClose={handleClose}
        onDelete={() => onDelete(task.id)}
        isEditing={edit.isEditing}
        onToggleEdit={() => edit.setIsEditing((value) => !value)}
        parentTask={parentTask}
        onSelectParent={onSelectTask}
        onSave={edit.handleSave}
        onDiscard={() => edit.setIsEditing(false)}
      >
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
