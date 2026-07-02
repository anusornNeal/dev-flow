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
      <div className="space-y-2 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
        <SectionHeader isAddingBug={isAddingBug} setIsAddingBug={setIsAddingBug} openCount={0} />
        {isAddingBug && (
          <AddBugForm
            newBug={newBug}
            setNewBug={setNewBug}
            onSubmit={submitNewBug}
          />
        )}
        <p className="text-[10px] text-[#a59182] dark:text-[#d6b56d] italic font-mono pl-1 font-bold">No embedded bug threads.</p>
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
    <div className="space-y-3 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
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
              className="group rounded-2xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#292119] overflow-hidden"
            >
              <summary className="list-none cursor-pointer p-3 flex items-start justify-between gap-3 hover:bg-[#f4ebd9] dark:hover:bg-[#3a2f26]/30">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {open && <AlertTriangle size={13} className="text-[#b4533a] dark:text-[#e0a070]" />}
                    <span className="text-xs font-black text-[#4d3d32] dark:text-[#f3eadf]">{bug.title}</span>
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-md bg-[#f4ebd9] dark:bg-[#1e1914] text-[#8a6e5a] dark:text-[#d6b56d]">
                      {bug.status}
                    </span>
                    <span className="text-[9px] font-mono uppercase px-1.5 py-0.5 rounded-md bg-[#f1e4df] dark:bg-[#1e1914] text-[#9b4e3d] dark:text-[#e0a070]">
                      {bug.severity}
                    </span>
                  </div>
                  {bug.actual && (
                    <p className="text-[10.5px] text-[#6e5340] dark:text-[#f3eadf] line-clamp-2">{bug.actual}</p>
                  )}
                </div>
                <ChevronDown size={14} className="mt-0.5 shrink-0 text-[#8a6e5a] dark:text-[#d6b56d] transition-transform group-open:rotate-180" />
              </summary>

              <div className="border-t border-[#ebdcb9] dark:border-[#584a3b] p-3 space-y-3 text-[10.5px] text-[#5c493c] dark:text-[#f3eadf]">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {bug.expected && (
                    <div>
                      <strong className="block text-[9px] uppercase tracking-widest font-mono text-[#8a6e5a] dark:text-[#d6b56d]">Expected</strong>
                      <p className="whitespace-pre-wrap">{bug.expected}</p>
                    </div>
                  )}
                  {bug.evidence && (
                    <div>
                      <strong className="block text-[9px] uppercase tracking-widest font-mono text-[#8a6e5a] dark:text-[#d6b56d]">Evidence</strong>
                      <p className="whitespace-pre-wrap">{bug.evidence}</p>
                    </div>
                  )}
                </div>

                {bug.relatedAreas && bug.relatedAreas.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {bug.relatedAreas.map((area) => (
                      <span key={area} className="px-2 py-1 rounded-lg bg-[#f4ebd9] dark:bg-[#1e1914] font-mono text-[9.5px]">
                        {area}
                      </span>
                    ))}
                  </div>
                )}

                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-1.5 text-[9.5px] font-mono text-[#8a6e5a] dark:text-[#d6b56d]">
                    <History size={12} /> {bug.versions.length} version{bug.versions.length === 1 ? '' : 's'}
                  </div>
                  <div className="flex items-center gap-1.5 flex-wrap justify-end">
                    <select
                      value={variantByBugId[bug.id] || 'standard'}
                      onChange={(event) => setVariantByBugId((prev) => ({ ...prev, [bug.id]: event.target.value as BugFixPromptVariant }))}
                      className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf]"
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
                        className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#f3ead7] dark:hover:bg-[#292119] disabled:opacity-60"
                      >
                        Mark Fixed
                      </button>
                    )}
                    {bug.status !== 'verified' && (
                      <button
                        type="button"
                        disabled={updatingBugId === bug.id}
                        onClick={() => updateStatus(bug, 'verified')}
                        className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#f3ead7] dark:hover:bg-[#292119] disabled:opacity-60"
                      >
                        Verify
                      </button>
                    )}
                    {!isUnresolved(bug) && (
                      <button
                        type="button"
                        disabled={updatingBugId === bug.id}
                        onClick={() => updateStatus(bug, 'reopened')}
                        className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#f3ead7] dark:hover:bg-[#292119] disabled:opacity-60"
                      >
                        Reopen
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => copyPrompt(bug)}
                      className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#f3ead7] dark:hover:bg-[#292119]"
                    >
                      <Copy size={12} /> {copiedBugId === bug.id ? 'Copied' : 'Copy Fix Prompt'}
                    </button>
                  </div>
                </div>
                <div className="rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf7] dark:bg-[#1e1914] p-2 space-y-2">
                  <p className="text-[9.5px] font-mono text-[#8a6e5a] dark:text-[#d6b56d]">
                    Same behavior failed again: add a version. Different behavior: create a new bug thread.
                  </p>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <input
                      value={versionDraftByBugId[bug.id]?.prompt || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { summary: '', changedFiles: '' }), prompt: event.target.value } }))}
                      placeholder="Version prompt"
                      className="md:col-span-3 px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119] text-[10px]"
                    />
                    <input
                      value={versionDraftByBugId[bug.id]?.summary || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { prompt: '', changedFiles: '' }), summary: event.target.value } }))}
                      placeholder="Summary"
                      className="md:col-span-2 px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119] text-[10px]"
                    />
                    <input
                      value={versionDraftByBugId[bug.id]?.changedFiles || ''}
                      onChange={(event) => setVersionDraftByBugId((prev) => ({ ...prev, [bug.id]: { ...(prev[bug.id] || { prompt: '', summary: '' }), changedFiles: event.target.value } }))}
                      placeholder="Files"
                      className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119] text-[10px]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={() => submitVersion(bug)}
                    disabled={!versionDraftByBugId[bug.id]?.prompt?.trim()}
                    className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#292119] text-[10px] font-mono font-bold disabled:opacity-60"
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
      <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
        <Bug size={13} className="text-[#b4533a] dark:text-[#e0a070]" /> Bugs to Fix
      </h4>
      <div className="flex items-center gap-2">
        <span className="text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#d6b56d]">{openCount} open</span>
        <button
          type="button"
          onClick={() => setIsAddingBug(!isAddingBug)}
          className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#f3eadf]"
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
    <div className="rounded-2xl border border-[#ebdcb9] dark:border-[#584a3b] bg-[#fffdfa] dark:bg-[#292119] p-3 space-y-2">
      <input value={newBug.title} onChange={(event) => setNewBug((prev) => ({ ...prev, title: event.target.value }))} placeholder="Bug title" className="w-full px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[10px]" />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <input value={newBug.actual} onChange={(event) => setNewBug((prev) => ({ ...prev, actual: event.target.value }))} placeholder="Actual" className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[10px]" />
        <input value={newBug.expected} onChange={(event) => setNewBug((prev) => ({ ...prev, expected: event.target.value }))} placeholder="Expected" className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[10px]" />
        <input value={newBug.evidence} onChange={(event) => setNewBug((prev) => ({ ...prev, evidence: event.target.value }))} placeholder="Evidence / notes" className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[10px]" />
        <input value={newBug.relatedAreas} onChange={(event) => setNewBug((prev) => ({ ...prev, relatedAreas: event.target.value }))} placeholder="Related files / areas" className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[10px]" />
      </div>
      <button type="button" onClick={onSubmit} disabled={!newBug.title.trim()} className="px-2 py-1 rounded-lg border border-[#ebdcb9] dark:border-[#584a3b] bg-[#faf7f0] dark:bg-[#1e1914] text-[10px] font-mono font-bold disabled:opacity-60">
        Create Bug
      </button>
    </div>
  );
}
