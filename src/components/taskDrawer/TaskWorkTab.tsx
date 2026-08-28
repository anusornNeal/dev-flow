import React from 'react';
import { Check, CheckSquare, Copy, FileCode, GitBranch, PlayCircle, ShieldCheck } from 'lucide-react';
import type { Task } from '../../types';
import { AGENTS_CONFIG, defaultEffortForModel, defaultModelForAgent, getModelConfig, type AgentName } from '../../lib/agentsConfig';

interface TaskWorkTabProps {
  task: Task;
  isEditing: boolean;
  editedBranch: string;
  setEditedBranch: (value: string) => void;
  editedFilesList: string[];
  setEditedFilesList: (value: string[]) => void;
  editedChecklistList: string[];
  setEditedChecklistList: (value: string[]) => void;
  editedAgent: string;
  setEditedAgent: (value: string) => void;
  editedModel: string;
  setEditedModel: (value: string) => void;
  editedEffort: string;
  setEditedEffort: (value: string) => void;
  editedVerification: string;
  setEditedVerification: (value: string) => void;
  onToggleChecklistItem: (itemIdentifier: string) => void;
}

const inputClass = 'df-control w-full min-w-0 text-[13px] outline-none';
const labelClass = 'mb-1.5 block text-[10px] font-black uppercase tracking-[0.08em] text-[var(--df-color-text-muted)]';

function WorkSection({ title, icon, children }: { title: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="df-surface min-w-0 p-5">
      <h3 className="df-heading-sm mb-3 flex items-center gap-2 uppercase tracking-[0.08em]">{icon}{title}</h3>
      {children}
    </section>
  );
}

export function splitTargetFilePath(filePath: string): { fileName: string; directory: string } {
  const normalized = filePath.trim();
  const match = /^(.*[\\/])([^\\/]+)$/.exec(normalized);
  if (!match) return { fileName: normalized, directory: '' };
  return { fileName: match[2], directory: match[1] };
}

export default function TaskWorkTab(props: TaskWorkTabProps) {
  const { task, isEditing } = props;
  const checklist = task.checklist || [];
  const completed = checklist.filter((item) => item.completed).length;
  const agentOptions = Object.keys(AGENTS_CONFIG) as AgentName[];
  const modelOptions = props.editedAgent ? (AGENTS_CONFIG[props.editedAgent as AgentName] || []) : [];
  const effortOptions = props.editedAgent && props.editedModel
    ? (getModelConfig(props.editedAgent, props.editedModel)?.availableEfforts || [])
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <div className="space-y-5">
          <WorkSection title="Checklist" icon={<CheckSquare size={15} />}>
            {!isEditing ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 text-[12px] font-bold text-[#7a6656] dark:text-[#c7b8aa]">
                  <span>{completed} of {checklist.length} complete</span>
                  <span>{checklist.length > 0 ? Math.round((completed / checklist.length) * 100) : 0}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-[#efe5d6] dark:bg-[#3a3028]"><div className="h-full rounded-full bg-[#6f9d54]" style={{ width: `${checklist.length > 0 ? (completed / checklist.length) * 100 : 0}%` }} /></div>
                <div className="space-y-2">
                  {checklist.map((item) => (
                    <button key={item.id || item.text} type="button" onClick={() => props.onToggleChecklistItem(item.id || item.text)} className="flex w-full items-start gap-3 rounded-xl border border-[#eadbc5] p-3 text-left hover:bg-[#faf4e9] dark:border-[#584a3b] dark:hover:bg-[#342920]">
                      <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${item.completed ? 'border-[#6f9d54] bg-[#6f9d54] text-white' : 'border-[#cbb79d]'}`}>{item.completed && <Check size={12} />}</span>
                      <span className={`min-w-0 break-words text-[13px] leading-5 ${item.completed ? 'text-[var(--df-color-text-subtle)] line-through' : 'text-[var(--df-color-text)]'}`}>{item.text}</span>
                    </button>
                  ))}
                  {checklist.length === 0 && <p className="text-[12px] text-[#9a8879]">No checklist items.</p>}
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {props.editedChecklistList.map((item, index) => (
                  <div key={index} className="flex gap-2">
                    <input className={inputClass} value={item} onChange={(event) => { const next = [...props.editedChecklistList]; next[index] = event.target.value; props.setEditedChecklistList(next); }} />
                    <button type="button" onClick={() => props.setEditedChecklistList(props.editedChecklistList.filter((_, itemIndex) => itemIndex !== index))} className="rounded-lg px-3 text-[11px] font-bold text-red-600 hover:bg-red-50">Remove</button>
                  </div>
                ))}
                <button type="button" onClick={() => props.setEditedChecklistList([...props.editedChecklistList, ''])} className="rounded-lg border border-[#dfccb1] px-3 py-2 text-[11px] font-extrabold text-[#805e42] dark:border-[#584a3b]">Add checklist item</button>
              </div>
            )}
          </WorkSection>

          <WorkSection title="Target files" icon={<FileCode size={15} />}>
            {!isEditing ? (
              <div className="space-y-2.5">
                {(task.targetFiles || []).map((file) => {
                  const { fileName, directory } = splitTargetFilePath(file);
                  return (
                    <div key={file} className="flex min-w-0 items-center gap-3 rounded-xl border border-[#eadbc5] bg-[#faf6ef] px-3.5 py-3 dark:border-[#584a3b] dark:bg-[#211a15]">
                      <div className="min-w-0 flex-1">
                        <span className="block break-words text-[13px] font-extrabold text-[var(--df-color-text-strong)]">{fileName || file}</span>
                        {directory && <span className="df-break-technical mt-1 block font-mono text-[11px] leading-4 text-[var(--df-color-text-muted)]">{directory}</span>}
                      </div>
                      <button
                        type="button"
                        aria-label="Copy target file path"
                        title={file}
                        onClick={() => { void navigator.clipboard?.writeText(file); }}
                        className="df-icon-button shrink-0 border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)]"
                      >
                        <Copy size={14} />
                      </button>
                    </div>
                  );
                })}
                {(task.targetFiles || []).length === 0 && <p className="text-[12px] text-[#9a8879]">No target files.</p>}
              </div>
            ) : (
              <div className="space-y-2">
                {props.editedFilesList.map((file, index) => (
                  <div key={index} className="flex gap-2">
                    <input className={`${inputClass} font-mono`} value={file} onChange={(event) => { const next = [...props.editedFilesList]; next[index] = event.target.value; props.setEditedFilesList(next); }} />
                    <button type="button" onClick={() => props.setEditedFilesList(props.editedFilesList.filter((_, fileIndex) => fileIndex !== index))} className="rounded-lg px-3 text-[11px] font-bold text-red-600 hover:bg-red-50">Remove</button>
                  </div>
                ))}
                <button type="button" onClick={() => props.setEditedFilesList([...props.editedFilesList, ''])} className="rounded-lg border border-[#dfccb1] px-3 py-2 text-[11px] font-extrabold text-[#805e42] dark:border-[#584a3b]">Add target file</button>
              </div>
            )}
          </WorkSection>

        </div>

        <div className="space-y-5">
          <WorkSection title="Execution" icon={<PlayCircle size={15} />}>
            {isEditing ? (
              <div className="space-y-4">
                <div><label className={labelClass}>Branch</label><input className={`${inputClass} font-mono`} value={props.editedBranch} onChange={(event) => props.setEditedBranch(event.target.value)} /></div>
                <div>
                  <label className={labelClass}>Agent</label>
                  <select className={inputClass} value={props.editedAgent} onChange={(event) => {
                    const agent = event.target.value;
                    props.setEditedAgent(agent);
                    if (!agent) {
                      props.setEditedModel('');
                      props.setEditedEffort('');
                      return;
                    }
                    const model = defaultModelForAgent(agent);
                    props.setEditedModel(model);
                    props.setEditedEffort(defaultEffortForModel(agent, model));
                  }}>
                    <option value="">Unassigned</option>
                    {agentOptions.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Model</label>
                  <select className={inputClass} value={props.editedModel} disabled={!props.editedAgent} onChange={(event) => {
                    const model = event.target.value;
                    props.setEditedModel(model);
                    props.setEditedEffort(model ? defaultEffortForModel(props.editedAgent, model) : '');
                  }}>
                    <option value="">None / Default</option>
                    {modelOptions.map((model) => <option key={model.model_name} value={model.model_name}>{model.display_name || model.label || model.model_name}</option>)}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Effort</label>
                  <select className={inputClass} value={props.editedEffort} disabled={!props.editedModel} onChange={(event) => props.setEditedEffort(event.target.value)}>
                    <option value="">No effort</option>
                    {effortOptions.map((effort) => <option key={effort} value={effort}>{effort}</option>)}
                  </select>
                </div>
              </div>
            ) : (
              <dl className="grid gap-3 text-[13px]">
                <div><dt className={labelClass}><GitBranch size={12} className="inline" /> Branch</dt><dd className="df-break-technical font-mono">{task.branch || 'Not assigned'}</dd></div>
                <div><dt className={labelClass}>Agent</dt><dd>{task.agent || 'Not assigned'}</dd></div>
                <div><dt className={labelClass}>Model</dt><dd>{task.model || 'Not assigned'}</dd></div>
                <div><dt className={labelClass}>Effort</dt><dd>{task.effort || 'Not assigned'}</dd></div>
              </dl>
            )}
          </WorkSection>

          <WorkSection title="Verification" icon={<ShieldCheck size={15} />}>
            {isEditing ? (
              <textarea className={`${inputClass} min-h-32 resize-y`} value={props.editedVerification} onChange={(event) => props.setEditedVerification(event.target.value)} />
            ) : (
              <div className="space-y-4">
                <p className="whitespace-pre-wrap break-words text-[13px]">{task.verification || 'No verification plan.'}</p>
                {(task.verificationEvidence || []).length > 0 && (
                  <div className="space-y-2">
                    {(task.verificationEvidence || []).map((check, index) => (
                      <div key={`${check.name}-${index}`} className="rounded-xl border border-[#eadbc5] p-3 dark:border-[#584a3b]">
                        <div className="flex items-center justify-between gap-3"><strong className="text-[12px]">{check.name}</strong><span className={`rounded-md px-2 py-0.5 text-[10px] font-black uppercase ${check.status === 'passed' ? 'bg-emerald-100 text-emerald-700' : check.status === 'failed' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>{check.status}</span></div>
                        <code className="df-break-technical mt-1 block text-[11px] text-[var(--df-color-text-muted)]">{check.command}</code>
                        {check.summary && <p className="mt-1 break-words text-[12px]">{check.summary}</p>}
                      </div>
                    ))}
                  </div>
                )}
                {task.gitEvidence && (
                  <div className="df-break-technical rounded-xl bg-[var(--df-color-surface-subtle)] p-3 text-[12px]">
                    <strong>Git evidence:</strong> {task.gitEvidence.branch} @ {task.gitEvidence.commit.slice(0, 10)} · {task.gitEvidence.workingTreeClean ? 'clean' : 'dirty'} · {task.gitEvidence.pushed ? 'pushed' : 'local'}
                  </div>
                )}
              </div>
            )}
          </WorkSection>
        </div>
      </div>
    </div>
  );
}
