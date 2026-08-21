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
      className={`flex items-center gap-1.5 px-2 py-1 text-[11px] font-mono font-extrabold rounded-lg border transition-colors cursor-pointer ${
        status === 'copied'
          ? 'bg-[#e6f4ea] dark:bg-[#292119] text-[#137333] dark:text-[#f3eadf] border-[#ceead6] dark:border-[#584a3b]'
          : status === 'error'
          ? 'bg-[#fce8e6] dark:bg-[#292119] text-[#c5221f] dark:text-[#f3eadf] border-[#fad2cf] dark:border-[#584a3b]'
          : 'bg-[#faf7f0] dark:bg-[#1e1914] text-[#8a725f] dark:text-[#f3eadf] border-[#ddd0ba] dark:border-[#584a3b] hover:bg-[#f3ead7] dark:hover:bg-[#292119] hover:text-[#534135] dark:text-[#f3eadf] dark:hover:text-[#f3eadf]'
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
