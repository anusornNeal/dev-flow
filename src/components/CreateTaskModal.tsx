/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import {
  Bot,
  CheckSquare,
  FileCode,
  GitBranch,
  Image as ImageIcon,
  Link as LinkIcon,
  Sparkles,
  X,
  Zap,
} from 'lucide-react';
import { CustomSelect } from './CustomSelect';
import { AgentLogo } from './AgentLogo';
import { Task, TaskPriority, TaskStatus, ChecklistItem, TaskCategory, TaskImage } from '../types';
import ImageViewer from './ImageViewer';
import { AGENTS_CONFIG, getModelConfig, defaultModelForAgent, defaultEffortForModel } from '../lib/agentsConfig';

interface CreateTaskModalProps {
  onClose: () => void;
  onSubmit: (task: Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'logs'>) => void | Promise<void>;
  parentId?: string;
  parentTitle?: string;
}

const fieldClass = 'w-full rounded-xl border border-df-border bg-df-surface-raised px-3 py-2.5 text-[11px] text-df-text outline-none transition-colors placeholder:text-df-text-muted focus:border-df-accent focus:ring-2 focus:ring-[var(--df-color-focus-ring)]/20';
const selectClass = 'w-full rounded-xl border border-df-border bg-df-surface-raised px-3 py-2.5 text-[11px] text-df-text';

function FieldLabel({ children, optional = false }: { children: React.ReactNode; optional?: boolean }) {
  return (
    <div className="mb-1.5 flex min-w-0 items-center justify-between gap-2">
      <span className="min-w-0 truncate text-[9px] font-black uppercase tracking-[0.14em] text-df-text-muted">{children}</span>
      <span className={`shrink-0 text-[9px] font-semibold ${optional ? 'text-df-text-muted' : 'text-df-accent'}`}>
        {optional ? 'Optional' : 'Required'}
      </span>
    </div>
  );
}

export default function CreateTaskModal({ onClose, onSubmit, parentId, parentTitle }: CreateTaskModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [branch, setBranch] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [category, setCategory] = useState<TaskCategory>('general');
  const [status, setStatus] = useState<TaskStatus>('backlog');
  const [filesInput, setFilesInput] = useState('');
  const [checklistInput, setChecklistInput] = useState('');
  const [images, setImages] = useState<TaskImage[]>([]);
  const [specUrl, setSpecUrl] = useState('');
  const [agent, setAgent] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [viewingImage, setViewingImage] = useState<TaskImage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const handlePaste = async (event: React.ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) await uploadImage(file);
      }
    }
  };

  const uploadImage = async (file: File) => {
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await fetch('/api/images/upload', { method: 'POST', body: formData });
      if (response.ok) {
        const image = await response.json();
        setImages((current) => [...current, image]);
      }
    } catch (error) {
      console.error('Upload failed:', error);
    }
  };

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || submitting) return;

    const tagsArray: string[] = [];
    const filesArray = filesInput.split('\n').map((file) => file.trim()).filter(Boolean);
    const checklistLines = checklistInput.split('\n').map((line) => line.trim()).filter(Boolean);
    const parsedChecklist: ChecklistItem[] = checklistLines.map((line, index) => ({
      id: `step-${Date.now()}-${index}`,
      text: line,
      completed: false,
    }));

    setSubmitError(null);
    setSubmitting(true);
    try {
      await onSubmit({
        title: title.trim(),
        description: description.trim(),
        status,
        branch: branch.trim() || undefined,
        priority,
        category,
        tags: tagsArray,
        targetFiles: filesArray,
        checklist: parsedChecklist,
        images: images.length > 0 ? images : undefined,
        specUrl: specUrl.trim() || undefined,
        agent: agent || '',
        model: model || '',
        effort: effort || '',
        parentId: parentId || undefined,
      });
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Task creation failed. Review the form and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--df-color-backdrop)] p-3 backdrop-blur-xs sm:p-4" onPaste={handlePaste}>
      <div className="fixed inset-0" onClick={onClose} aria-hidden="true" />
      <ImageViewer image={viewingImage} onClose={() => setViewingImage(null)} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-task-title"
        className="relative z-10 flex max-h-[calc(100vh-1.5rem)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-df-border bg-df-surface shadow-[var(--df-shadow-lg)] sm:max-h-[calc(100vh-2rem)]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-df-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-df-accent">
              <Sparkles size={16} />
              <span className="text-[9px] font-black uppercase tracking-[0.16em]">Task authoring</span>
            </div>
            <h2 id="create-task-title" className="mt-1 text-base font-black text-df-text">
              {parentId ? 'Create subtask' : 'Create task'}
            </h2>
            <p className="mt-1 max-w-xl text-[10px] leading-relaxed text-df-text-muted">
              Add the required title first, then fill only the execution context the task actually needs.
            </p>
            {parentTitle && (
              <p className="mt-2 max-w-full truncate rounded-lg bg-df-surface-muted px-2.5 py-1.5 text-[9px] font-semibold text-df-text-muted" title={`${parentId} · ${parentTitle}`}>
                Parent: {parentId} · {parentTitle}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} aria-label="Close create task dialog" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-df-text-muted hover:bg-df-surface-muted hover:text-df-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
            <X size={15} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-5 scrollbar-thin">
            <section className="space-y-3">
              <div>
                <p className="text-[10px] font-black text-df-text">Basics</p>
                <p className="mt-0.5 text-[9px] text-df-text-muted">The title is the only required field in this dialog.</p>
              </div>

              <label className="block">
                <FieldLabel>Task title</FieldLabel>
                <input
                  type="text"
                  required
                  autoFocus
                  aria-required="true"
                  className={`${fieldClass} text-xs font-semibold`}
                  placeholder="e.g. Improve project switcher keyboard navigation"
                  value={title}
                  onChange={(event) => { setTitle(event.target.value); setSubmitError(null); }}
                />
              </label>

              <label className="block">
                <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                  <FieldLabel optional>Detailed description</FieldLabel>
                  <button type="button" onClick={injectTemplate} className="rounded-lg px-2 py-1 text-[9px] font-bold text-df-accent hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
                    Use spec template
                  </button>
                </div>
                <textarea
                  className={`${fieldClass} min-h-28 resize-y leading-relaxed`}
                  placeholder="Describe the goal, constraints, expected behavior, and useful implementation context."
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </label>
            </section>

            <section className="border-t border-df-border pt-4">
              <div className="mb-3">
                <p className="text-[10px] font-black text-df-text">Planning</p>
                <p className="mt-0.5 text-[9px] text-df-text-muted">Choose where the task starts and how it should be classified.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block min-w-0">
                  <FieldLabel optional><span className="inline-flex items-center gap-1"><GitBranch size={11} /> Branch</span></FieldLabel>
                  <input className={`${fieldClass} font-mono`} placeholder="feature/example" value={branch} onChange={(event) => setBranch(event.target.value)} />
                </label>
                <div className="min-w-0">
                  <FieldLabel optional>Starting status</FieldLabel>
                  <CustomSelect className={selectClass} value={status} onChange={(value) => setStatus(value as TaskStatus)} options={[
                    { value: 'backlog', label: 'Backlog' },
                    { value: 'todo', label: 'To Do' },
                    { value: 'in-progress', label: 'In Progress' },
                    { value: 'ready-for-review', label: 'Ready for Review' },
                    { value: 'done', label: 'Done' },
                  ]} />
                </div>
                <div className="min-w-0">
                  <FieldLabel optional>Category</FieldLabel>
                  <CustomSelect className={selectClass} value={category} onChange={(value) => setCategory(value as TaskCategory)} options={[
                    { value: 'general', label: 'General / Fullstack' },
                    { value: 'frontend', label: 'Frontend / UI' },
                    { value: 'backend', label: 'Backend / Infrastructure' },
                  ]} />
                </div>
                <div className="min-w-0">
                  <FieldLabel optional>Priority</FieldLabel>
                  <CustomSelect className={selectClass} value={priority} onChange={(value) => setPriority(value as TaskPriority)} options={[
                    { value: 'low', label: 'Low' },
                    { value: 'medium', label: 'Medium' },
                    { value: 'high', label: 'High' },
                  ]} />
                </div>
              </div>
            </section>

            <section className="border-t border-df-border pt-4">
              <div className="mb-3">
                <p className="text-[10px] font-black text-df-text">Agent execution <span className="font-semibold text-df-text-muted">· Optional</span></p>
                <p className="mt-0.5 text-[9px] text-df-text-muted">Leave unassigned to use the normal task defaults.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                <div className="min-w-0">
                  <FieldLabel optional>Agent</FieldLabel>
                  <CustomSelect className={selectClass} value={agent} onChange={(value) => {
                    setAgent(value);
                    if (value) {
                      const defaultModel = defaultModelForAgent(value);
                      setModel(defaultModel);
                      setEffort(defaultEffortForModel(value, defaultModel));
                    } else {
                      setModel('');
                      setEffort('');
                    }
                  }} options={[
                    { value: '', label: 'Unassigned', icon: <Bot size={13} className="opacity-60" /> },
                    { value: 'Codex', label: 'Codex', icon: <AgentLogo agent="Codex" size={13} /> },
                    { value: 'Antigravity', label: 'Antigravity', icon: <AgentLogo agent="Antigravity" size={13} /> },
                    { value: 'Claude', label: 'Claude', icon: <AgentLogo agent="Claude" size={13} /> },
                  ]} />
                </div>
                <div className="min-w-0">
                  <FieldLabel optional>Model</FieldLabel>
                  <CustomSelect className={`${selectClass} ${!agent ? 'pointer-events-none opacity-50' : ''}`} value={model} onChange={(value) => {
                    setModel(value);
                    setEffort(agent && value ? defaultEffortForModel(agent, value) : '');
                  }} options={[
                    { value: '', label: 'None / Default' },
                    ...(agent ? (AGENTS_CONFIG[agent as import('../lib/agentsConfig').AgentName] || []).map((item) => ({
                      value: item.model_name,
                      label: item.display_name || item.label || item.model_name,
                    })) : []),
                  ]} />
                </div>
                <div className="min-w-0">
                  <FieldLabel optional>Effort</FieldLabel>
                  <CustomSelect className={`${selectClass} ${(!agent || !model) ? 'pointer-events-none opacity-50' : ''}`} value={effort} onChange={setEffort} options={
                    agent && model
                      ? (getModelConfig(agent, model)?.availableEfforts || []).map((item) => ({
                          value: item,
                          label: item === 'xhigh' ? 'Extra High' : item.charAt(0).toUpperCase() + item.slice(1),
                          icon: <Zap size={13} className="text-df-accent" />,
                        }))
                      : [{ value: '', label: 'No Effort' }]
                  } placeholder="No Effort" />
                </div>
              </div>
            </section>

            <section className="border-t border-df-border pt-4">
              <div className="mb-3">
                <p className="text-[10px] font-black text-df-text">Scope & evidence <span className="font-semibold text-df-text-muted">· Optional</span></p>
                <p className="mt-0.5 text-[9px] text-df-text-muted">Add implementation hints only when they make the task safer or easier to execute.</p>
              </div>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <label className="block min-w-0">
                  <FieldLabel optional><span className="inline-flex items-center gap-1"><FileCode size={11} /> Target files</span></FieldLabel>
                  <textarea className={`${fieldClass} min-h-24 resize-y font-mono`} placeholder={'One path per line\nsrc/components/Example.tsx'} value={filesInput} onChange={(event) => setFilesInput(event.target.value)} />
                </label>
                <label className="block min-w-0">
                  <FieldLabel optional><span className="inline-flex items-center gap-1"><CheckSquare size={11} /> Checklist</span></FieldLabel>
                  <textarea className={`${fieldClass} min-h-24 resize-y`} placeholder={'One step per line\nAdd keyboard navigation'} value={checklistInput} onChange={(event) => setChecklistInput(event.target.value)} />
                </label>
                <label className="block min-w-0">
                  <FieldLabel optional><span className="inline-flex items-center gap-1"><LinkIcon size={11} /> Specification URL</span></FieldLabel>
                  <input className={fieldClass} placeholder="Figma, Jira, docs, or spreadsheet link" value={specUrl} onChange={(event) => setSpecUrl(event.target.value)} />
                </label>
                <div className="min-w-0">
                  <FieldLabel optional><span className="inline-flex items-center gap-1"><ImageIcon size={11} /> Images</span></FieldLabel>
                  <div className="rounded-xl border border-df-border bg-df-surface-raised p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="cursor-pointer rounded-lg border border-df-border px-2.5 py-1.5 text-[9px] font-bold text-df-text hover:bg-df-surface-muted">
                        Upload images {images.length > 0 && `(${images.length})`}
                        <input type="file" accept="image/*" multiple className="hidden" onChange={(event) => Array.from(event.target.files || []).forEach((file) => { void uploadImage(file); })} />
                      </label>
                      {images.length > 0 && <button type="button" onClick={() => setImages([])} className="text-[9px] font-bold text-df-danger hover:underline">Clear all</button>}
                    </div>
                    {images.length > 0 && (
                      <div className="mt-2 flex max-w-full gap-2 overflow-x-auto pb-1">
                        {images.map((image) => (
                          <div key={image.id} className="group relative h-14 w-14 shrink-0 cursor-pointer overflow-hidden rounded-lg border border-df-border bg-df-surface" onClick={() => setViewingImage(image)}>
                            <img src={image.url} alt={image.filename} className="h-full w-full object-cover" />
                            <button type="button" aria-label={`Remove ${image.filename}`} onClick={(event) => { event.stopPropagation(); setImages((current) => current.filter((item) => item.id !== image.id)); }} className="absolute right-0 top-0 flex h-5 w-5 items-center justify-center rounded-bl-md bg-df-danger text-white opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100">×</button>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="mt-2 text-[9px] leading-relaxed text-df-text-muted">Paste images anywhere in this dialog or choose files here.</p>
                  </div>
                </div>
              </div>
            </section>

            {submitError && (
              <div role="alert" className="max-h-32 overflow-y-auto break-words rounded-xl border border-df-danger bg-[var(--df-color-danger-surface)] px-3 py-2.5 text-[10px] leading-relaxed text-df-danger">
                <p className="font-black">Could not create task</p>
                <p className="mt-1 font-semibold">{submitError}</p>
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-col-reverse gap-2 border-t border-df-border bg-df-surface px-5 py-4 sm:flex-row sm:items-center sm:justify-end">
            <button type="button" onClick={onClose} className="h-10 rounded-xl border border-df-border px-4 text-[10px] font-extrabold text-df-text-muted hover:bg-df-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              Cancel
            </button>
            <button type="submit" disabled={submitting || !title.trim()} className="h-10 rounded-xl bg-df-primary px-5 text-[10px] font-extrabold text-[var(--df-color-primary-text)] shadow-[var(--df-shadow-sm)] hover:bg-[var(--df-color-primary-hover)] disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--df-color-focus-ring)]">
              {submitting ? 'Creating task…' : parentId ? 'Create subtask' : 'Create task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
