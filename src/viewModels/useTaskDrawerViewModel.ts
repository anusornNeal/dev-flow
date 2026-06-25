import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiPut, apiPost } from '../client/apiClient.js';
import { taskRepository } from '../repositories/taskRepository.js';
import {
  buildEditStateFromTask,
  diffEditState,
  toggleChecklistItem,
  type EditState,
  type ChecklistItem,
} from './drawerUtils.js';
import type { DomainTask } from '../domain/mappers/taskMapper.js';

export interface UseTaskDrawerViewModel {
  task: DomainTask | null;
  edit: EditState | null;
  isDirty: boolean;
  changedFields: Array<keyof EditState>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  open: (taskId: string) => Promise<void>;
  close: () => void;
  setField: <K extends keyof EditState>(field: K, value: EditState[K]) => void;
  toggleChecklist: (id: string) => void;
  save: () => Promise<void>;
  discard: () => void;
}

export function useTaskDrawerViewModel(): UseTaskDrawerViewModel {
  const [task, setTask] = useState<DomainTask | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = useCallback(async (taskId: string) => {
    setLoading(true);
    setError(null);
    try {
      const next = await taskRepository.get(taskId);
      setTask(next);
      setEdit(buildEditStateFromTask(next));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  const close = useCallback(() => {
    setTask(null);
    setEdit(null);
    setError(null);
  }, []);

  const setField = useCallback(<K extends keyof EditState>(field: K, value: EditState[K]) => {
    setEdit((prev) => (prev ? { ...prev, [field]: value } : prev));
  }, []);

  const toggleChecklist = useCallback((id: string) => {
    setEdit((prev) => {
      if (!prev) return prev;
      return { ...prev, checklist: toggleChecklistItem(prev.checklist, id) };
    });
    setTask((prev) => {
      if (!prev) return prev;
      const checklist = Array.isArray(prev.checklist) ? prev.checklist : [];
      return { ...prev, checklist: toggleChecklistItem(checklist, id) };
    });
  }, []);

  const discard = useCallback(() => {
    if (task) setEdit(buildEditStateFromTask(task));
  }, [task]);

  const save = useCallback(async () => {
    if (!task || !edit) return;
    setSaving(true);
    setError(null);
    try {
      const payload: Record<string, unknown> = { ...edit };
      await apiPut(`/api/tasks/${encodeURIComponent(task.id)}`, payload);
      const refreshed = await taskRepository.get(task.id);
      setTask(refreshed);
      setEdit(buildEditStateFromTask(refreshed));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [task, edit]);

  const changedFields = useMemo<Array<keyof EditState>>(() => {
    if (!task || !edit) return [];
    return diffEditState(buildEditStateFromTask(task), edit);
  }, [task, edit]);

  const isDirty = changedFields.length > 0;

  return {
    task,
    edit,
    isDirty,
    changedFields,
    loading,
    saving,
    error,
    open,
    close,
    setField,
    toggleChecklist,
    save,
    discard,
  };
}
