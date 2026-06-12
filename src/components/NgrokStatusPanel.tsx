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
        className="flex items-center gap-1.5 bg-[#fff9f1] border border-[#f0c295] text-[#b0733a] hover:bg-[#faeedd] hover:text-[#8b5a2b] px-2.5 py-1 text-[10px] font-mono rounded-lg transition-colors cursor-pointer font-bold shadow-2xs"
      >
        <AlertCircle size={13} />
        <span>ngrok unset</span>
      </button>
    );
  }

  // To display compactly, we strip the protocol if it's there
  const displayUrl = ngrokUrl.replace(/^https?:\/\//, '');

  return (
    <div className="flex items-center gap-1 bg-[#fdfbf6] border border-[#e5d4bb] rounded-lg p-1 shadow-2xs text-[#816b5a] text-[10px] font-mono">
      <div 
        className="flex items-center gap-1.5 px-2 py-0.5"
        title="ngrok Tunnel Configured"
      >
        <div className="relative flex items-center justify-center">
          <Link size={12} className="text-[#659e51]" />
          <span className="absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse border border-[#fdfbf6]"></span>
        </div>
        <span className="truncate max-w-[120px] sm:max-w-[160px]">{displayUrl}</span>
      </div>
      
      <div className="w-px h-3 bg-[#e5d4bb]"></div>
      
      <button
        onClick={handleCopy}
        className="hover:bg-[#ebdcb9] hover:text-[#534135] px-1.5 py-0.5 rounded transition-colors cursor-pointer font-bold text-[#a46c24]"
        title="Copy URL"
      >
        {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
      </button>
    </div>
  );
}
