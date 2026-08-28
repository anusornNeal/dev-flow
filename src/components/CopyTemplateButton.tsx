import React, { useState } from 'react';
import { SquareTerminal, CheckCircle2, AlertCircle } from 'lucide-react';
import type { Task } from '../types';
import { copyText } from '../lib/clipboard';

export const copyPromptPath = (taskId: string) => '/api/tasks/' + taskId + '/prompt';

export const resolveCopyPromptTaskId = (task: Pick<Task, 'id' | 'displayId'>) => task.displayId || task.id;

export async function runCodexPromptCopy(
  taskId: string,
  request: (url: string) => Promise<Response>,
  copy: (text: string) => Promise<void>,
) {
  const res = await request(copyPromptPath(taskId));
  if (!res.ok) throw new Error('Failed to load prompt');
  const text = await res.text();
  await copy(text);
  return text;
}

interface CopyTemplateButtonProps {
  task: Task;
  className?: string;
  variant?: 'full' | 'icon';
}

export default function CopyTemplateButton({ task, className = '', variant = 'full' }: CopyTemplateButtonProps) {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    
    const displayId = resolveCopyPromptTaskId(task);

    try {
      await runCodexPromptCopy(displayId, fetch, copyText);
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (err) {
      console.error('Failed to copy prompt template:', err);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      onClick={handleCopy}
      title="Copy for Codex"
      aria-label="Copy for Codex"
      aria-live="polite"
      className={`df-button min-h-8 min-w-0 px-2 py-1 font-mono text-[11px] ${
        status === 'copied'
          ? 'df-button--secondary df-feedback--success'
          : status === 'error'
          ? 'df-button--secondary df-feedback--danger'
          : 'df-button--secondary'
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
          <SquareTerminal size={12} />
          {variant === 'full' && 'Copy for Codex'}
        </>
      )}
    </button>
  );
}
