import React, { useState } from 'react';
import { Copy, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Task } from '../types';

interface CopyTemplateButtonProps {
  task: Task;
  className?: string;
  variant?: 'full' | 'icon';
}

export default function CopyTemplateButton({ task, className = '', variant = 'full' }: CopyTemplateButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    
    const displayId = task.displayId || task.id;
    const apiBaseUrl = window.location.origin;

    const template = `This is a DevFlow task.

DevFlow is the source of truth.
Task ID: ${displayId}

Before doing any implementation work, fetch the task context from DevFlow:
GET ${apiBaseUrl}/api/tasks/${displayId}/agent-context

Do not search Jira, GitHub issues, or infer requirements from the repo unless the DevFlow context explicitly contains jiraKey/sourceUrl or asks you to do so.

Use the repo, localPath, branch, model, effort, checklist, acceptance criteria, verification steps, and repoContext from DevFlow context.

After fetching the context, execute the task directly.
Follow the DevFlow task requirements as the source of truth.
Keep changes scoped to the task.
Run the relevant verification steps.
Report what changed, what was verified, and any remaining issues.

Do not ask for confirmation unless the task context is missing, unsafe, ambiguous, or blocked.`;

    navigator.clipboard.writeText(template)
      .then(() => {
        setStatus('copied');
        setTimeout(() => setStatus('idle'), 2000);
      })
      .catch((err) => {
        console.error('Failed to copy starting template:', err);
        setStatus('error');
        setTimeout(() => setStatus('idle'), 3000);
      });
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy Starting Template for manual agent handoff"
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono font-extrabold rounded-lg border transition-colors ${
        status === 'copied'
          ? 'bg-[#e6f4ea] dark:bg-[#292119] text-[#137333] dark:text-[#f3eadf] border-[#ceead6] dark:border-[#584a3b]'
          : status === 'error'
          ? 'bg-[#fce8e6] dark:bg-[#292119] text-[#c5221f] dark:text-[#f3eadf] border-[#fad2cf] dark:border-[#584a3b]'
          : 'bg-[#faf7f0] dark:bg-[#1e1914] text-[#8a725f] dark:text-[#f3eadf] border-[#ddd0ba] dark:border-[#584a3b] hover:bg-[#f3ead7] dark:hover:bg-[#292119] hover:text-[#534135] dark:hover:text-[#f3eadf]'
      } ${className}`}
    >
      {status === 'copied' ? (
        <>
          <CheckCircle2 size={12} />
          {variant === 'full' && 'Copied'}
        </>
      ) : status === 'error' ? (
        <>
          <AlertCircle size={12} />
          {variant === 'full' && 'Failed'}
        </>
      ) : (
        <>
          <Copy size={12} />
          {variant === 'full' && 'Prompt Template'}
        </>
      )}
    </button>
  );
}
