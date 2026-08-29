import React from 'react';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import type { TaskUiEvidence } from '../../client/uiPreviewClient';
import type { Task, TaskCategory, TaskImage, TaskPriority, TaskStatus } from '../../types';
import MarkdownRenderer from '../MarkdownRenderer';
import UiDesignEvidenceSection from './UiDesignEvidenceSection';

interface TaskOverviewTabProps {
  task: Task;
  parentTask?: Task;
  subTasks?: Task[];
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
const labelClass = 'mb-1 block text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]';

function ReadSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="min-w-0 border-b border-[var(--df-color-border)] pb-4 last:border-b-0">
      <h3 className="mb-2 text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]">{title}</h3>
      <div className="min-w-0 break-words text-[13px] leading-[1.55] text-[var(--df-color-text)]">{children}</div>
    </section>
  );
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2 border-b border-[var(--df-color-border)] py-1.5 last:border-b-0">
      <span className="text-[9.5px] font-bold uppercase tracking-[0.05em] text-[var(--df-color-text-subtle)]">{label}</span>
      <span className="min-w-0 break-words text-[11px] font-semibold text-[var(--df-color-text)]">{children}</span>
    </div>
  );
}

function ReferenceLink({ label, href, children }: { label: string; href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="grid min-w-0 grid-cols-[72px_minmax(0,1fr)] gap-2 border-b border-[var(--df-color-border)] py-1.5 text-[11px] hover:text-[var(--df-color-info)] last:border-b-0"
    >
      <span className="text-[9.5px] font-bold uppercase tracking-[0.05em] text-[var(--df-color-text-subtle)]">{label}</span>
      <span className="df-break-technical inline-flex min-w-0 items-start gap-1 font-mono text-[10.5px] text-[var(--df-color-info)]">
        <ExternalLink size={11} className="mt-0.5 shrink-0" />
        <span className="min-w-0 break-all">{children}</span>
      </span>
    </a>
  );
}

export default function TaskOverviewTab(props: TaskOverviewTabProps) {
  const { task, isEditing } = props;
  const subTasks = props.subTasks || [];
  const completedSubtasks = subTasks.filter((subTask) => subTask.status === 'done').length;

  if (isEditing) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <div>
          <label className={labelClass} htmlFor="task-inspector-title">Title</label>
          <input id="task-inspector-title" className={fieldClass} value={props.editedTitle} onChange={(event) => props.setEditedTitle(event.target.value)} />
        </div>

        <div className="grid gap-3 md:grid-cols-3">
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

        <div className="grid gap-3 md:grid-cols-2">
          <div><label className={labelClass} htmlFor="task-inspector-repo">Repository</label><input id="task-inspector-repo" className={`${fieldClass} df-break-technical font-mono`} value={props.editedRepo} onChange={(event) => props.setEditedRepo(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-jira">Jira key</label><input id="task-inspector-jira" className={fieldClass} value={props.editedJiraKey} onChange={(event) => props.setEditedJiraKey(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-source">Source URL</label><input id="task-inspector-source" className={`${fieldClass} df-break-technical font-mono`} value={props.editedSourceUrl} onChange={(event) => props.setEditedSourceUrl(event.target.value)} /></div>
          <div><label className={labelClass} htmlFor="task-inspector-spec">Specification URL</label><input id="task-inspector-spec" className={`${fieldClass} df-break-technical font-mono`} value={props.editedSpecUrl} onChange={(event) => props.setEditedSpecUrl(event.target.value)} /></div>
        </div>

        <section className="df-surface p-3">
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
    <div className="mx-auto grid max-w-6xl min-w-0 gap-6 2xl:grid-cols-[minmax(0,1fr)_240px]">
      <main data-testid="task-inspector-main-content" className="min-w-0 max-w-[80ch] space-y-5">
        <ReadSection title="Description">
          {task.description ? (
            <div className="prose max-w-none break-words text-[13px] leading-[1.55] dark:prose-invert">
              <MarkdownRenderer content={task.description} />
            </div>
          ) : (
            <p className="text-[12px] text-[var(--df-color-text-subtle)]">No description provided.</p>
          )}
        </ReadSection>

        {task.acceptanceCriteria && (
          <ReadSection title="Acceptance criteria">
            <p className="whitespace-pre-wrap break-words">{task.acceptanceCriteria}</p>
          </ReadSection>
        )}

        <UiDesignEvidenceSection
          evidence={props.uiEvidence}
          loading={props.uiEvidenceLoading}
          loadingMore={props.uiEvidenceLoadingMore}
          error={props.uiEvidenceError}
          nextCursor={props.uiEvidenceNextCursor}
          onRefresh={props.onRefreshUiEvidence}
          onLoadMore={props.onLoadMoreUiEvidence}
        />

        {(task.reasoning || task.repoContext) && (
          <details className="group min-w-0 border-b border-[var(--df-color-border)] pb-4">
            <summary className="cursor-pointer select-none text-[11px] font-extrabold uppercase tracking-[0.08em] text-[var(--df-color-text-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--df-color-focus-ring)]">
              Engineering context
            </summary>
            <div className="mt-3 space-y-4 rounded-lg bg-[var(--df-color-surface-subtle)] p-3">
              {task.reasoning && (
                <div className="min-w-0">
                  <h4 className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[var(--df-color-text-subtle)]">Reasoning</h4>
                  <p className="whitespace-pre-wrap break-words text-[12.5px] leading-[1.5] text-[var(--df-color-text)]">{task.reasoning}</p>
                </div>
              )}
              {task.repoContext && (
                <div className="min-w-0">
                  <h4 className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.06em] text-[var(--df-color-text-subtle)]">Repository context</h4>
                  <p className="df-break-technical whitespace-pre-wrap font-mono text-[11px] leading-[1.5] text-[var(--df-color-text-muted)]">{task.repoContext}</p>
                </div>
              )}
            </div>
          </details>
        )}

        {(task.images || []).length > 0 && (
          <ReadSection title="Images">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              {(task.images || []).map((image) => (
                <button key={image.id} type="button" onClick={() => props.onViewImage(image)} className="group min-w-0 overflow-hidden rounded-lg border border-[var(--df-color-border)] text-left">
                  <img src={image.url} alt={image.filename} className="h-32 w-full object-cover" />
                  <span className="flex min-w-0 items-center gap-1.5 px-2 py-1.5 text-[11px]"><ImageIcon size={12} className="shrink-0" /> <span className="df-truncate">{image.filename}</span></span>
                </button>
              ))}
            </div>
          </ReadSection>
        )}
      </main>

      <aside className="min-w-0 space-y-4 2xl:sticky 2xl:top-2 2xl:self-start" aria-label="Task facts">
        <section className="min-w-0 rounded-lg border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
          <h3 className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]">Task facts</h3>
          <FactRow label="Status">{task.status}</FactRow>
          <FactRow label="Priority">{task.priority}</FactRow>
          {task.category && <FactRow label="Category">{task.category}</FactRow>}
          {props.parentTask && <FactRow label="Parent">{props.parentTask.displayId || props.parentTask.id}</FactRow>}
          {subTasks.length > 0 && <FactRow label="Subtasks">{completedSubtasks}/{subTasks.length} subtasks complete</FactRow>}
          {task.branch && <FactRow label="Branch"><span className="df-break-technical font-mono text-[10px]">{task.branch}</span></FactRow>}
          {task.createdAt && <FactRow label="Created">{new Date(task.createdAt).toLocaleDateString()}</FactRow>}
          {task.updatedAt && <FactRow label="Updated">{new Date(task.updatedAt).toLocaleDateString()}</FactRow>}
        </section>

        {(task.repo || task.sourceUrl || task.specUrl || task.jiraKey) && (
          <section className="min-w-0 rounded-lg border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
            <h3 className="mb-1 text-[10px] font-extrabold uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]">References</h3>
            {task.repo && <FactRow label="Repository"><span className="df-break-technical font-mono text-[10px]">{task.repo}</span></FactRow>}
            {task.jiraKey && <FactRow label="Jira"><span className="font-mono text-[10px]">{task.jiraKey}</span></FactRow>}
            {task.sourceUrl && <ReferenceLink label="Source" href={task.sourceUrl}>{task.sourceUrl}</ReferenceLink>}
            {task.specUrl && <ReferenceLink label="Spec" href={task.specUrl.startsWith('http') ? task.specUrl : `https://${task.specUrl}`}>{task.specUrl}</ReferenceLink>}
          </section>
        )}
      </aside>
    </div>
  );
}
