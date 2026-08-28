import React from 'react';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import type { TaskUiEvidence } from '../../client/uiPreviewClient';
import type { Task, TaskCategory, TaskImage, TaskPriority, TaskStatus } from '../../types';
import MarkdownRenderer from '../MarkdownRenderer';
import UiDesignEvidenceSection from './UiDesignEvidenceSection';

interface TaskOverviewTabProps {
  task: Task;
  isEditing: boolean;
  editedTitle: string;
  setEditedTitle: (value: string) => void;
  editedDesc: string;
  setEditedDesc: (value: string) => void;
  editedStatus: TaskStatus;
  setEditedStatus: (value: TaskStatus) => void;
  editedPriority: TaskPriority;
  setEditedPriority: (value: TaskPriority) => void;
  editedCategory: TaskCategory;
  setEditedCategory: (value: TaskCategory) => void;
  editedAcceptance: string;
  setEditedAcceptance: (value: string) => void;
  editedReasoning: string;
  setEditedReasoning: (value: string) => void;
  editedRepoContext: string;
  setEditedRepoContext: (value: string) => void;
  editedSpecUrl: string;
  setEditedSpecUrl: (value: string) => void;
  editedRepo: string;
  setEditedRepo: (value: string) => void;
  editedJiraKey: string;
  setEditedJiraKey: (value: string) => void;
  editedSourceUrl: string;
  setEditedSourceUrl: (value: string) => void;
  editedImages: TaskImage[];
  setEditedImages: React.Dispatch<React.SetStateAction<TaskImage[]>>;
  uploadImage: (file: File) => Promise<void>;
  onViewImage: (image: TaskImage) => void;
  uiEvidence: TaskUiEvidence[];
  uiEvidenceLoading: boolean;
  uiEvidenceLoadingMore: boolean;
  uiEvidenceError: string | null;
  uiEvidenceNextCursor: string | null;
  onRefreshUiEvidence: () => void;
  onLoadMoreUiEvidence: () => void;
}

const fieldClass = 'df-control w-full min-w-0 text-[13px] outline-none';
const labelClass = 'mb-1.5 block text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]';

function ReadSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="df-surface min-w-0 p-5">
      <h3 className="df-heading-sm mb-3 uppercase tracking-[0.08em]">{title}</h3>
      <div className="min-w-0 break-words text-[13px] leading-6 text-[var(--df-color-text)]">{children}</div>
    </section>
  );
}

export default function TaskOverviewTab(props: TaskOverviewTabProps) {
  const { task, isEditing } = props;

  if (isEditing) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <label className={labelClass} htmlFor="task-inspector-title">Title</label>
          <input id="task-inspector-title" className={fieldClass} value={props.editedTitle} onChange={(event) => props.setEditedTitle(event.target.value)} />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={labelClass} htmlFor="task-inspector-status">Status</label>
            <select id="task-inspector-status" className={fieldClass} value={props.editedStatus} onChange={(event) => props.setEditedStatus(event.target.value as TaskStatus)}>
              {['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="task-inspector-priority">Priority</label>
            <select id="task-inspector-priority" className={fieldClass} value={props.editedPriority} onChange={(event) => props.setEditedPriority(event.target.value as TaskPriority)}>
              {['low', 'medium', 'high'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass} htmlFor="task-inspector-category">Category</label>
            <select id="task-inspector-category" className={fieldClass} value={props.editedCategory} onChange={(event) => props.setEditedCategory(event.target.value as TaskCategory)}>
              {['general', 'frontend', 'backend'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className={labelClass} htmlFor="task-inspector-description">Description</label>
          <textarea id="task-inspector-description" className={`${fieldClass} min-h-44 resize-y whitespace-pre-wrap`} value={props.editedDesc} onChange={(event) => props.setEditedDesc(event.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="task-inspector-acceptance">Acceptance criteria</label>
          <textarea id="task-inspector-acceptance" className={`${fieldClass} min-h-32 resize-y whitespace-pre-wrap`} value={props.editedAcceptance} onChange={(event) => props.setEditedAcceptance(event.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="task-inspector-reasoning">Reasoning</label>
          <textarea id="task-inspector-reasoning" className={`${fieldClass} min-h-28 resize-y whitespace-pre-wrap`} value={props.editedReasoning} onChange={(event) => props.setEditedReasoning(event.target.value)} />
        </div>
        <div>
          <label className={labelClass} htmlFor="task-inspector-repo-context">Repository context</label>
          <textarea id="task-inspector-repo-context" className={`${fieldClass} df-break-technical min-h-28 resize-y font-mono`} value={props.editedRepoContext} onChange={(event) => props.setEditedRepoContext(event.target.value)} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div><label className={labelClass} htmlFor="task-inspector-repo">Repository</label><input id="task-inspector-repo" className={`${fieldClass} df-break-technical font-mono`} value={props.editedRepo} onChange={(event) => props.setEditedRepo(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-jira">Jira key</label><input id="task-inspector-jira" className={fieldClass} value={props.editedJiraKey} onChange={(event) => props.setEditedJiraKey(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-source">Source URL</label><input id="task-inspector-source" className={`${fieldClass} df-break-technical font-mono`} value={props.editedSourceUrl} onChange={(event) => props.setEditedSourceUrl(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-spec">Specification URL</label><input id="task-inspector-spec" className={`${fieldClass} df-break-technical font-mono`} value={props.editedSpecUrl} onChange={(event) => props.setEditedSpecUrl(event.target.value)} /></div>
        </div>

        <section className="df-surface p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="df-heading-sm">Images</h3>
              <p className="df-meta mt-1 break-words">Paste an image anywhere in the inspector or add a file here.</p>
            </div>
            <label className="df-button df-button--secondary cursor-pointer">
              Add image
              <input type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.uploadImage(file); }} />
            </label>
          </div>
          {props.editedImages.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {props.editedImages.map((image) => (
                <div key={image.id} className="relative min-w-0 overflow-hidden rounded-xl border border-[var(--df-color-border)]">
                  <button type="button" onClick={() => props.onViewImage(image)} className="block w-full"><img src={image.url} alt={image.filename} className="h-28 w-full object-cover" /></button>
                  <button type="button" onClick={() => props.setEditedImages((current) => current.filter((item) => item.id !== image.id))} aria-label={`Remove ${image.filename}`} className="absolute right-1.5 top-1.5 rounded-lg bg-black/65 px-2 py-1 text-[10px] font-bold text-white">Remove</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <ReadSection title="Description">
        {task.description ? <div className="prose max-w-none break-words text-[13px] leading-6 dark:prose-invert"><MarkdownRenderer content={task.description} /></div> : <p className="text-[var(--df-color-text-subtle)]">No description.</p>}
      </ReadSection>
      {task.acceptanceCriteria && <ReadSection title="Acceptance criteria"><p className="whitespace-pre-wrap break-words">{task.acceptanceCriteria}</p></ReadSection>}
      <UiDesignEvidenceSection
        evidence={props.uiEvidence}
        loading={props.uiEvidenceLoading}
        loadingMore={props.uiEvidenceLoadingMore}
        error={props.uiEvidenceError}
        nextCursor={props.uiEvidenceNextCursor}
        onRefresh={props.onRefreshUiEvidence}
        onLoadMore={props.onLoadMoreUiEvidence}
      />
      {task.reasoning && <ReadSection title="Reasoning"><p className="whitespace-pre-wrap break-words">{task.reasoning}</p></ReadSection>}
      {task.repoContext && <ReadSection title="Repository context"><p className="df-break-technical whitespace-pre-wrap font-mono text-[12px]">{task.repoContext}</p></ReadSection>}

      {(task.repo || task.sourceUrl || task.specUrl || task.jiraKey) && (
        <ReadSection title="References">
          <div className="grid min-w-0 gap-3 md:grid-cols-2">
            {task.repo && <div className="df-break-technical min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3 font-mono text-[12px]">Repository: {task.repo}</div>}
            {task.jiraKey && <div className="df-break-technical min-w-0 rounded-xl bg-[var(--df-color-surface-subtle)] p-3 font-mono text-[12px]">Jira: {task.jiraKey}</div>}
            {task.sourceUrl && <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="df-break-technical flex min-w-0 items-start gap-2 rounded-xl border border-[var(--df-color-border)] p-3 font-semibold text-[var(--df-color-info)] hover:bg-[var(--df-color-surface-subtle)]"><ExternalLink size={14} className="mt-1 shrink-0" /> <span className="min-w-0 break-all">{task.sourceUrl}</span></a>}
            {task.specUrl && <a href={task.specUrl.startsWith('http') ? task.specUrl : `https://${task.specUrl}`} target="_blank" rel="noreferrer" className="df-break-technical flex min-w-0 items-start gap-2 rounded-xl border border-[var(--df-color-border)] p-3 font-semibold text-[var(--df-color-info)] hover:bg-[var(--df-color-surface-subtle)]"><ExternalLink size={14} className="mt-1 shrink-0" /> <span className="min-w-0 break-all">{task.specUrl}</span></a>}
          </div>
        </ReadSection>
      )}

      {(task.images || []).length > 0 && (
        <ReadSection title="Images">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(task.images || []).map((image) => (
              <button key={image.id} type="button" onClick={() => props.onViewImage(image)} className="group min-w-0 overflow-hidden rounded-xl border border-[var(--df-color-border)] text-left">
                <img src={image.url} alt={image.filename} className="h-32 w-full object-cover" />
                <span className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-[11px]"><ImageIcon size={12} className="shrink-0" /> <span className="df-truncate">{image.filename}</span></span>
              </button>
            ))}
          </div>
        </ReadSection>
      )}
    </div>
  );
}
