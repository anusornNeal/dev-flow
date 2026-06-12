import React, { useState } from 'react';
import { Link, Copy, CheckCircle2, AlertCircle } from 'lucide-react';

interface NgrokStatusPanelProps {
  ngrokUrl: string;
  onOpenSettings: () => void;
}

export default function NgrokStatusPanel({ ngrokUrl, onOpenSettings }: NgrokStatusPanelProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!ngrokUrl) return;
    navigator.clipboard.writeText(ngrokUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="flex flex-col gap-1.5 w-full sm:max-w-xs border border-[#e5d4bb] bg-[#fffcf8] p-3 rounded-xl shadow-xs">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-extrabold text-[#534135] flex items-center gap-1.5 uppercase tracking-wider">
          <Link size={12} className={ngrokUrl ? "text-[#d89745]" : "text-[#c4b3a1]"} />
          ngrok Tunnel Status
        </h3>
        {ngrokUrl ? (
          <span className="flex items-center gap-1 text-[9px] font-bold text-green-700 bg-green-100 px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
            Configured
          </span>
        ) : (
          <span className="text-[9px] font-bold text-[#9e8b7a] bg-[#f0e7dc] px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            Not Set
          </span>
        )}
      </div>

      {ngrokUrl ? (
        <div className="flex items-center justify-between bg-[#faf7f0] border border-[#e5d4bb] rounded-lg p-1.5 mt-1 transition-colors hover:border-[#d89745]">
          <span className="text-xs font-mono text-[#6e584a] truncate px-1" title={ngrokUrl}>
            {ngrokUrl}
          </span>
          <button
            onClick={handleCopy}
            className="flex-shrink-0 text-[#8c7463] hover:text-[#534135] bg-white border border-[#e5d4bb] hover:border-[#d89745] p-1.5 rounded-md transition-all shadow-sm flex items-center justify-center min-w-[28px]"
            title="Copy URL"
          >
            {copied ? <CheckCircle2 size={13} className="text-green-500" /> : <Copy size={13} />}
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-2">
          <AlertCircle size={14} className="text-[#d89745] flex-shrink-0" />
          <p className="text-[10px] text-[#8c7463] leading-snug">
            Run your tunnel and set the URL in{' '}
            <button onClick={onOpenSettings} className="font-bold text-[#d89745] hover:underline focus:outline-none">
              Settings
            </button>{' '}
            to connect agents.
          </p>
        </div>
      )}
    </div>
  );
}
