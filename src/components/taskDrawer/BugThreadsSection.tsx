import React, { useState } from 'react';
import { AlertTriangle, Bug, ChevronDown, Copy, History } from 'lucide-react';
import type { BugThread } from '../../types';
import { copyText } from '../../lib/clipboard';
import { BUG_FIX_PROMPT_VARIANTS, buildBugFixPrompt, type BugFixPromptVariant } from '../../lib/bugFixPromptTemplates';

const UNRESOLVED = new Set(['open', 'fixing', 'fixed', 'reopened']);

function isUnresolved(bug: BugThread) {
  return UNRESOLVED.has(bug.status);
}

function orderBugs(bugs: BugThread[]) {
  return bugs.slice().sort((left, right) => {
    const leftUnresolved = isUnresolved(left);
    const rightUnresolved = isUnresolved(right);
    if (leftUnresolved !== rightUnresolved) return leftUnresolved ? -1 : 1;
    return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
  });
}

function latestPrompt(bug: BugThread) {
  return bug.versions[bug.versions.length - 1]?.prompt || bug.title;
}

interface BugThreadsSectionProps {
  task: {
    id: string;
    displayId?: string;
    title: string;
    status: any;
    branch?: string;
  };
  bugs?: BugThread[];
  onTaskUpdated?: (task: any) => void;
}

export default function BugThreadsSection({ task, bugs = [], onTaskUpdated }: BugThreadsSectionProps) {
  const orderedBugs = orderBugs(bugs);
  const latestUnresolved = orderedBugs.find(isUnresolved);
  const [copiedBugId, setCopiedBugId] = useState<string | null>(null);
  const [updatingBugId, setUpdatingBugId] = useState<string | null>(null);
  const [variantByBugId, setVariantByBugId] = useState<Record<string, BugFixPromptVariant>>({});
  const [isAddingBug, setIsAddingBug] = useState(false);
  const [newBug, setNewBug] = useState({ title: '', actual: '', expected: '', evidence: '', relatedAreas: '' });
  const [versionDraftByBugId, setVersionDraftByBugId] = useState<Record<string, { prompt: string; summary: string; changedFiles: string }>>({});

  if (orderedBugs.length === 0) {
    return (
      <div className="space-y-2 border-t border-df-border pt-5">
        <SectionHeader isAddingBug={isAddingBug} setIsAddingBug={setIsAddingBug} openCount={0} />
        {isAddingBug && (
          <AddBugForm
            newBug={newBug}
            setNewBug={setNewBug}
            onSubmit={submitNewBug}
          />
        )}
        <p className="df-meta pl-1 font-mono italic">No embedded bug threads.</p>
      </div>
    );
  }

  const copyPrompt = async (bug: BugThread) => {
    const prompt = buildBugFixPrompt(
      task,
      bug,
      variantByBugId[bug.id] || 'standard',
    );
    await copyText(prompt || latestPrompt(bug));
    setCopiedBugId(bug.id);
    window.setTimeout(() => setCopiedBugId(null), 1800);
  };

  const updateStatus = async (bug: BugThread, status: BugThread['status']) => {
    setUpdatingBugId(bug.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(task.displayId || task.id)}/bugs/${encodeURIComponent(bug.id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      const body = await response.json();
      if (response.ok && body?.task && onTaskUpdated) {
        onTaskUpdated(body.task);
      }
    } finally {
      setUpdatingBugId(null);
    }
  };

  async function submitNewBug() {
    if (!newBug.title.trim()) return;
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.displayId || task.id)}/bugs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newBug.title.trim(),
        source: 'manual',
        severity: 'medium',
        actual: newBug.actual.trim() || undefined,
        expected: newBug.expected.trim() || undefined,
        evidence: newBug.evidence.trim() || undefined,
        relatedAreas: newBug.relatedAreas.split(',').map((item) => item.trim()).filter(Boolean),
        prompt: newBug.title.trim(),
      }),
    });
    const body = await response.json();
    if (response.ok && body?.task && onTaskUpdated) onTaskUpdated(body.task);
    setNewBug({ title: '', actual: '', expected: '', evidence: '', relatedAreas: '' });
    setIsAddingBug(false);
  }

  async function submitVersion(bug: BugThread) {
    const draft = versionDraftByBugId[bug.id];
    if (!draft?.prompt.trim()) return;
    const response = await fetch(`/api/tasks/${encodeURIComponent(task.displayId || task.id)}/bugs/${encodeURIComponent(bug.id)}/versions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: draft.prompt.trim(),
        summary: draft.summary.trim() || undefined,
        changedFiles: draft.changedFiles.split(',').map((item) => item.trim()).filter(Boolean),
      }),
    });
    const body = await response.json();
    if (response.ok && body?.task && onTaskUpdated) onTaskUpdated(body.task);
    setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { prompt: '', summary: '', changedFiles: '' } }));
  }

  return (
    <div className="space-y-3 border-t border-df-border pt-5">
      <SectionHeader isAddingBug={isAddingBug} setIsAddingBug={setIsAddingBug} openCount={orderedBugs.filter(isUnresolved).length} />
      {isAddingBug && <AddBugForm newBug={newBug} setNewBug={setNewBug} onSubmit={submitNewBug} />}

      <div className="space-y-2">
        {orderedBugs.map((bug) => {
          const defaultOpen = bug.id === latestUnresolved?.id;
          const open = isUnresolved(bug);
          return (
            <details
              key={bug.id}
              open={defaultOpen}
              className="group overflow-hidden rounded-2xl border border-df-border bg-df-surface"
            >
              <summary className="flex cursor-pointer list-none items-start justify-between gap-3 p-3 hover:bg-df-surface-muted">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {open && <AlertTriangle size={13} className="text-df-danger" />}
                    <span className="text-xs font-black text-[var(--df-color-text-strong)]">{bug.title}</span>
                    <span className="rounded-md bg-df-surface-muted px-1.5 py-0.5 font-mono text-[10px] uppercase text-df-text-muted">
                      {bug.status}
                    </span>
                    <span className="rounded-md bg-[var(--df-color-danger-surface)] px-1.5 py-0.5 font-mono text-[10px] uppercase text-df-danger">
                      {bug.severity}
                    </span>
                  </div>
                  {bug.actual && (
                    <p className="line-clamp-2 text-[10.5px] text-df-text">{bug.actual}</p>
                  )}
                </div>
                <ChevronDown size={14} className="mt-0.5 shrink-0 text-df-text-muted transition-transform group-open:rotate-180" />
              </summary>

              <div className="space-y-3 border-t border-df-border p-3 text-[10.5px] text-df-text">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {bug.expected && (
                    <div>
                      <strong className="block font-mono text-[10px] uppercase tracking-widest text-df-text-muted">Expected</strong>
                      <p className="whitespace-pre-wrap">{bug.expected}</p>
                    </div>
                  )}
                  {bug.evidence && (
                    <div>
                      <strong className="block font-mono text-[10px] uppercase tracking-widest text-df-text-muted">Evidence</strong>
                      <p className="whitespace-pre-wrap">{bug.evidence}</p>
                    </div>
                  )}
                </div>

                {bug.relatedAreas && bug.relatedAreas.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {bug.relatedAreas.map((area) => (
                      <span key={area} className="rounded-lg bg-df-surface-muted px-2 py-1 font-mono text-[10px]">
                        {area}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 font-mono text-[10px] text-df-text-muted">
                    <History size={12} /> {bug.versions.length} version{bug.versions.length === 1 ? '' : 's'}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <select
                      value={variantByBugId[bug.id] || 'standard'}
                      onChange={(event) => setVariantByBugId((prev) => ({ ...prev, [bug.id]: event.target.value as BugFixPromptVariant }))}
                      className="df-control px-2 font-mono text-[10px] font-bold text-df-text-muted"
                      title="Fix prompt variant"
                    >
                      {BUG_FIX_PROMPT_VARIANTS.map((variant) => (
                        <option key={variant.id} value={variant.id}>{variant.label}</option>
                      ))}
                    </select>
                    {bug.status !== 'fixed' && isUnresolved(bug) && (
                      <button
                        type="button"
                        disabled={updatingBugId === bug.id}
                        onClick={() => updateStatus(bug, 'fixed')}
                        className="df-button df-button--secondary min-w-0 px-2 text-[10px] disabled:opacity-60"
                      >
                        Mark Fixed
                      </button>
                    )}
                    {bug.status !== 'verified' && (
                      <button
                        type="button"
                        disabled={updatingBugId === bug.id}
                        onClick={() => updateStatus(bug, 'verified')}
                        className="df-button df-button--secondary min-w-0 px-2 text-[10px] disabled:opacity-60"
                      >
                        Verify
                      </button>
                    )}
                    {!isUnresolved(bug) && (
                      <button
                        type="button"
                        disabled={updatingBugId === bug.id}
                        onClick={() => updateStatus(bug, 'reopened')}
                        className="df-button df-button--secondary min-w-0 px-2 text-[10px] disabled:opacity-60"
                      >
                        Reopen
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => copyPrompt(bug)}
                      className="df-button df-button--secondary min-w-0 px-2 text-[10px]"
                    >
                      <Copy size={12} /> {copiedBugId === bug.id ? 'Copied' : 'Copy Fix Prompt'}
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-xl border border-df-border bg-df-surface p-2">
                  <p className="font-mono text-[10px] text-df-text-muted">
                    Same behavior failed again: add a version. Different behavior: create a new bug thread.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <input
                      value={versionDraftByBugId[bug.id]?.prompt || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { summary: '', changedFiles: '' }), prompt: event.target.value } }))}
                      placeholder="Version prompt"
                      className="df-control md:col-span-3 px-2 text-[10px]"
                    />
                    <input
                      value={versionDraftByBugId[bug.id]?.summary || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { prompt: '', changedFiles: '' }), summary: event.target.value } }))}
                      placeholder="Summary"
                      className="df-control md:col-span-2 px-2 text-[10px]"
                    />
                    <input
                      value={versionDraftByBugId[bug.id]?.changedFiles || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { prompt: '', summary: '' }), changedFiles: event.target.value } }))}
                      placeholder="Files"
                      className="df-control px-2 text-[10px]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => submitVersion(bug)}
                    disabled={!versionDraftByBugId[bug.id]?.prompt?.trim()}
                    className="df-button df-button--secondary min-w-0 px-2 text-[10px] disabled:opacity-60"
                  >
                    Add Version
                  </button>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function SectionHeader({ isAddingBug, setIsAddingBug, openCount }: { isAddingBug: boolean; setIsAddingBug: (value: boolean) => void; openCount: number }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h4 className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-widest text-df-text-muted">
        <Bug size={13} className="text-df-danger" /> Bugs to Fix
      </h4>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] font-bold text-df-text-muted">{openCount} open</span>
        <button
          type="button"
          onClick={() => setIsAddingBug(!isAddingBug)}
          className="df-button df-button--secondary min-w-0 px-2 text-[10px]"
        >
          + Add Bug
        </button>
      </div>
    </div>
  );
}

function AddBugForm({ newBug, setNewBug, onSubmit }: {
  newBug: { title: string; actual: string; expected: string; evidence: string; relatedAreas: string };
  setNewBug: React.Dispatch<React.SetStateAction<{ title: string; actual: string; expected: string; evidence: string; relatedAreas: string }>>;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-2 rounded-2xl border border-df-border bg-df-surface p-3">
      <input value={newBug.title} onChange={(event) => setNewBug((prev) => ({ ...prev, title: event.target.value }))} placeholder="Bug title" className="df-control w-full px-2 text-[10px]" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input value={newBug.actual} onChange={(event) => setNewBug((prev) => ({ ...prev, actual: event.target.value }))} placeholder="Actual" className="df-control px-2 text-[10px]" />
        <input value={newBug.expected} onChange={(event) => setNewBug((prev) => ({ ...prev, expected: event.target.value }))} placeholder="Expected" className="df-control px-2 text-[10px]" />
        <input value={newBug.evidence} onChange={(event) => setNewBug((prev) => ({ ...prev, evidence: event.target.value }))} placeholder="Evidence / notes" className="df-control px-2 text-[10px]" />
        <input value={newBug.relatedAreas} onChange={(event) => setNewBug((prev) => ({ ...prev, relatedAreas: event.target.value }))} placeholder="Related files / areas" className="df-control px-2 text-[10px]" />
      </div>
      <button type="button" onClick={onSubmit} disabled={!newBug.title.trim()} className="df-button df-button--secondary min-w-0 px-2 text-[10px] disabled:opacity-60">
        Create Bug
      </button>
    </div>
  );
}
