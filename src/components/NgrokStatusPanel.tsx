import React, { useState } from 'react';
import { Link, Copy, CheckCircle2, AlertCircle } from 'lucide-react';

interface NgrokStatusPanelProps {
  ngrokUrl: string;
  onOpenSettings: () => void;
}

export default function NgrokStatusPanel({ ngrokUrl, onOpenSettings }: NgrokStatusPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!ngrokUrl) return;
    navigator.clipboard.writeText(ngrokUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!ngrokUrl) {
    return (
      <button 
        onClick={onOpenSettings}
        title="ngrok URL not configured. Click to set in Settings."
        className="flex items-center gap-1.5 bg-[#fff9f1] dark:bg-[#292119] border border-[#f0c295] dark:border-[#584a3b] text-[#b0733a] dark:text-[#f3eadf] hover:bg-[#faeedd] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] hover:text-[#8b5a2b] dark:text-[#d6b56d] dark:hover:text-[#f3eadf] px-2.5 py-1 text-[10px] font-mono rounded-lg transition-colors cursor-pointer font-bold shadow-2xs"
      >
        <AlertCircle size={13} />
        <span>ngrok unset</span>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1 bg-[#fdfbf6] dark:bg-[#292119] border border-[#e5d4bb] dark:border-[#584a3b] rounded-lg p-1 shadow-2xs text-[#816b5a] dark:text-[#f3eadf] text-[10px] font-mono">
      <div 
        className="flex items-center gap-1.5 px-2 py-0.5"
        title="ngrok Tunnel Configured"
      >
        <div className="relative flex items-center justify-center">
          <Link size={12} className="text-[#659e51] dark:text-[#f3eadf]" />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse border border-[#fdfbf6] dark:border-[#292119]"></span>
        </div>
        <span className="truncate max-w-[220px]">{ngrokUrl}</span>
      </div>
      
      <div className="w-px h-3 bg-[#e5d4bb] dark:bg-[#584a3b]"></div>
      
      <button
        onClick={handleCopy}
        className="hover:bg-[#ebdcb9] dark:bg-[#584a3b] dark:hover:bg-[#584a3b] hover:text-[#534135] dark:hover:text-[#f3eadf] px-1.5 py-0.5 rounded transition-colors cursor-pointer font-bold text-[#a46c24] dark:text-[#f3eadf]"
        title="Copy URL"
      >
        {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
