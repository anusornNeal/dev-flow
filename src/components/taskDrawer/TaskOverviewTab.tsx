import React from 'react';
import { ExternalLink, Image as ImageIcon } from 'lucide-react';
import type { Task, TaskCategory, TaskImage, TaskPriority, TaskStatus } from '../../types';
import MarkdownRenderer from '../MarkdownRenderer';

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
}

const fieldClass = 'w-full rounded-xl border border-[#e3d2bb] bg-white px-3.5 py-2.5 text-[13px] text-[#44352c] outline-none focus:border-[#d89745] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#f1e7de]';
const labelClass = 'mb-1.5 block text-[11px] font-extrabold uppercase tracking-[0.08em] text-[#8a6e5a] dark:text-[#c5b4a5]';

function ReadSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#eadbc5] bg-white/75 p-5 dark:border-[#584a3b] dark:bg-[#292119]/65">
      <h3 className="mb-3 text-[12px] font-black uppercase tracking-[0.08em] text-[#9a6427] dark:text-[#e0a070]">{title}</h3>
      <div className="text-[13px] leading-6 text-[#514035] dark:text-[#eee4db]">{children}</div>
    </section>
  );
}

export default function TaskOverviewTab(props: TaskOverviewTabProps) {
  const { task, isEditing } = props;

  if (isEditing) {
    return (
      <div className="mx-auto max-w-5xl space-y-5">
        <div>
          <label className={labelClass}>Title</label>
          <input className={fieldClass} value={props.editedTitle} onChange={(event) => props.setEditedTitle(event.target.value)} />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <div>
            <label className={labelClass}>Status</label>
            <select className={fieldClass} value={props.editedStatus} onChange={(event) => props.setEditedStatus(event.target.value as TaskStatus)}>
              {['backlog', 'todo', 'in-progress', 'ready-for-review', 'done'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Priority</label>
            <select className={fieldClass} value={props.editedPriority} onChange={(event) => props.setEditedPriority(event.target.value as TaskPriority)}>
              {['low', 'medium', 'high'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
          <div>
            <label className={labelClass}>Category</label>
            <select className={fieldClass} value={props.editedCategory} onChange={(event) => props.setEditedCategory(event.target.value as TaskCategory)}>
              {['general', 'frontend', 'backend'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className={labelClass}>Description</label>
          <textarea className={`${fieldClass} min-h-44 resize-y font-mono`} value={props.editedDesc} onChange={(event) => props.setEditedDesc(event.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Acceptance criteria</label>
          <textarea className={`${fieldClass} min-h-32 resize-y`} value={props.editedAcceptance} onChange={(event) => props.setEditedAcceptance(event.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Reasoning</label>
          <textarea className={`${fieldClass} min-h-28 resize-y`} value={props.editedReasoning} onChange={(event) => props.setEditedReasoning(event.target.value)} />
        </div>
        <div>
          <label className={labelClass}>Repository context</label>
          <textarea className={`${fieldClass} min-h-28 resize-y font-mono`} value={props.editedRepoContext} onChange={(event) => props.setEditedRepoContext(event.target.value)} />
        </div>

        <div className="grid gap-4 md:grid-cols-2">
          <div><label className={labelClass}>Repository</label><input className={fieldClass} value={props.editedRepo} onChange={(event) => props.setEditedRepo(event.target.value)} /></div>
          <div><label className={labelClass}>Jira key</label><input className={fieldClass} value={props.editedJiraKey} onChange={(event) => props.setEditedJiraKey(event.target.value)} /></div>
          <div><label className={labelClass}>Source URL</label><input className={fieldClass} value={props.editedSourceUrl} onChange={(event) => props.setEditedSourceUrl(event.target.value)} /></div>
          <div><label className={labelClass}>Specification URL</label><input className={fieldClass} value={props.editedSpecUrl} onChange={(event) => props.setEditedSpecUrl(event.target.value)} /></div>
        </div>

        <section className="rounded-2xl border border-[#eadbc5] bg-white/75 p-4 dark:border-[#584a3b] dark:bg-[#292119]/65">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-[12px] font-black text-[#584638] dark:text-[#f1e7de]">Images</h3>
              <p className="text-[11px] text-[#927d6c] dark:text-[#ad9d91]">Paste an image anywhere in the inspector or add a file here.</p>
            </div>
            <label className="cursor-pointer rounded-lg border border-[#dfccb1] bg-white px-3 py-2 text-[11px] font-extrabold text-[#7d6048] dark:border-[#584a3b] dark:bg-[#211a15] dark:text-[#e2d5ca]">
              Add image
              <input type="file" accept="image/*" className="hidden" onChange={(event) => { const file = event.target.files?.[0]; if (file) void props.uploadImage(file); }} />
            </label>
          </div>
          {props.editedImages.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {props.editedImages.map((image) => (
                <div key={image.id} className="relative overflow-hidden rounded-xl border border-[#eadbc5] dark:border-[#584a3b]">
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
        {task.description ? <div className="prose max-w-none text-[13px] leading-6 dark:prose-invert"><MarkdownRenderer content={task.description} /></div> : <p className="text-[#9a8879]">No description.</p>}
      </ReadSection>
      {task.acceptanceCriteria && <ReadSection title="Acceptance criteria"><p className="whitespace-pre-wrap">{task.acceptanceCriteria}</p></ReadSection>}
      {task.reasoning && <ReadSection title="Reasoning"><p className="whitespace-pre-wrap">{task.reasoning}</p></ReadSection>}
      {task.repoContext && <ReadSection title="Repository context"><p className="whitespace-pre-wrap font-mono text-[12px]">{task.repoContext}</p></ReadSection>}

      {(task.repo || task.sourceUrl || task.specUrl || task.jiraKey) && (
        <ReadSection title="References">
          <div className="grid gap-3 md:grid-cols-2">
            {task.repo && <div className="rounded-xl bg-[#f8f1e6] p-3 font-mono text-[12px] dark:bg-[#211a15]">Repository: {task.repo}</div>}
            {task.jiraKey && <div className="rounded-xl bg-[#f8f1e6] p-3 font-mono text-[12px] dark:bg-[#211a15]">Jira: {task.jiraKey}</div>}
            {task.sourceUrl && <a href={task.sourceUrl} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-[#e3d2bb] p-3 font-semibold text-[#34788f] hover:bg-[#f8f1e6] dark:border-[#584a3b]"><ExternalLink size={14} /> {task.sourceUrl}</a>}
            {task.specUrl && <a href={task.specUrl.startsWith('http') ? task.specUrl : `https://${task.specUrl}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl border border-[#e3d2bb] p-3 font-semibold text-[#34788f] hover:bg-[#f8f1e6] dark:border-[#584a3b]"><ExternalLink size={14} /> {task.specUrl}</a>}
          </div>
        </ReadSection>
      )}

      {(task.images || []).length > 0 && (
        <ReadSection title="Images">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {(task.images || []).map((image) => (
              <button key={image.id} type="button" onClick={() => props.onViewImage(image)} className="group overflow-hidden rounded-xl border border-[#eadbc5] text-left dark:border-[#584a3b]">
                <img src={image.url} alt={image.filename} className="h-32 w-full object-cover" />
                <span className="flex items-center gap-1.5 truncate px-2 py-1.5 text-[11px]"><ImageIcon size={12} /> {image.filename}</span>
              </button>
            ))}
          </div>
        </ReadSection>
      )}
    </div>
  );
}
