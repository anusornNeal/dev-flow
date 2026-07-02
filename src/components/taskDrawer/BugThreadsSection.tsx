import React, { useState } from 'react';
import { AlertTriangle, Bug, ChevronDown, Copy, History } from 'lucide-react';
import type { BugThread } from '../../types';
import { copyText } from '../../lib/clipboard';

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
  taskId: string;
  bugs?: BugThread[];
  onTaskUpdated?: (task: any) => void;
}

export default function BugThreadsSection({ taskId, bugs = [], onTaskUpdated }: BugThreadsSectionProps) {
  const orderedBugs = orderBugs(bugs);
  const latestUnresolved = orderedBugs.find(isUnresolved);
  const [copiedBugId, setCopiedBugId] = useState<string | null>(null);
  const [updatingBugId, setUpdatingBugId] = useState<string | null>(null);

  if (orderedBugs.length === 0) {
    return (
      <div className="space-y-2 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
        <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
          <Bug size={13} className="text-[#b4533a] dark:text-[#e0a070]" /> Bugs to Fix
        </h4>
        <p className="text-[10px] text-[#a59182] dark:text-[#d6b56d] italic font-mono pl-1 font-bold">No embedded bug threads.</p>
      </div>
    );
  }

  const copyPrompt = async (bug: BugThread) => {
    await copyText(latestPrompt(bug));
    setCopiedBugId(bug.id);
    window.setTimeout(() => setCopiedBugId(null), 1800);
  };

  const updateStatus = async (bug: BugThread, status: BugThread['status']) => {
    setUpdatingBugId(bug.id);
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/bugs/${encodeURIComponent(bug.id)}/status`, {
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

  return (
    <div className="space-y-3 border-t border-[#ebdcb9] dark:border-[#584a3b] pt-5">
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-[10px] font-mono text-[#8a6e5a] dark:text-[#f3eadf] uppercase tracking-widest flex items-center gap-1.5 font-bold">
          <Bug size={13} className="text-[#b4533a] dark:text-[#e0a070]" /> Bugs to Fix
        </h4>
        <span className="text-[10px] font-mono font-bold text-[#8a6e5a] dark:text-[#d6b56d]">
          {orderedBugs.filter(isUnresolved).length} open
        </span>
      </div>

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
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}
