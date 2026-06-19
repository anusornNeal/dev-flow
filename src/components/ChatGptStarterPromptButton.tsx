import React, { useState } from 'react';
import { CheckCircle2, MessageSquareText, AlertCircle } from 'lucide-react';
import { buildChatGptStarterPrompt } from '../lib/chatGptStarterPrompt';

export default function ChatGptStarterPromptButton() {
  const [status, setStatus] = useState<'idle' | 'copied' | 'error'>('idle');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(buildChatGptStarterPrompt());
      setStatus('copied');
      setTimeout(() => setStatus('idle'), 2000);
    } catch (error) {
      console.error('Failed to copy ChatGPT starter prompt:', error);
      setStatus('error');
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="w-full text-left px-4 py-2 hover:bg-[#ebdcb9] dark:bg-[#584a3b]/30 dark:hover:bg-[#584a3b]/40 text-xs font-bold text-[#7a6455] dark:text-[#f3eadf] flex items-center gap-2 transition-colors cursor-pointer"
      title="Copy starter prompt for a new ChatGPT chat"
    >
      {status === 'copied' ? (
        <CheckCircle2 size={14} className="text-emerald-600" />
      ) : status === 'error' ? (
        <AlertCircle size={14} className="text-red-600" />
      ) : (
        <MessageSquareText size={14} className="text-[#a46c24] dark:text-[#d6b56d]" />
      )}
      {status === 'copied' ? 'Starter Copied' : status === 'error' ? 'Copy Failed' : 'ChatGPT Starter'}
    </button>
  );
}
