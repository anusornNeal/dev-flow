import React, { useEffect, useRef, useState } from 'react';
import { FileText, X, Copy, Check, Loader2, AlertTriangle } from 'lucide-react';

interface AgentRunLogModalProps {
  taskDisplayId: string;
  runId: string;
  runStatus?: string;
  agent?: string | null;
  model?: string | null;
  onClose: () => void;
}

export default function AgentRunLogModal({
  taskDisplayId,
  runId,
  runStatus,
  agent,
  model,
  onClose,
}: AgentRunLogModalProps) {
  const [content, setContent] = useState<string | null>(null);
  const [logPath, setLogPath] = useState<string | null>(null);
  const [exists, setExists] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);

    fetch(`/api/tasks/${encodeURIComponent(taskDisplayId)}/agent-runs/${encodeURIComponent(runId)}/log`)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(data?.error || `Failed to load log (${res.status})`);
        }
        return data;
      })
      .then((data) => {
        if (cancelled) return;
        setContent(typeof data?.content === 'string' ? data.content : '');
        setLogPath(typeof data?.logPath === 'string' ? data.logPath : null);
        setExists(Boolean(data?.exists));
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err?.message || 'Failed to load log');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [taskDisplayId, runId]);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleCopy = () => {
    if (!content) return;
    navigator.clipboard.writeText(content).then(
      () => {
        setCopied(true);
        if (copyTimerRef.current) window.clearTimeout(copyTimerRef.current);
        copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
      },
      () => {
        setError('Clipboard copy failed.');
      },
    );
  };

  const sizeLabel = content ? `${content.length.toLocaleString()} chars` : '—';
  const lineCount = content ? content.split(/\r?\n/).length : 0;
  const headerLabel = `${taskDisplayId} · ${runId.slice(0, 8)}`;
  const subtitleParts = [agent, model, runStatus].filter(Boolean);

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in select-text">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="bg-[#fcfaf5] dark:bg-[#1e1914] border border-[#ebdcb9] dark:border-[#584a3b] w-full max-w-3xl h-[80vh] rounded-2xl shadow-2xl relative z-10 overflow-hidden flex flex-col font-sans">
        <div className="p-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#ebdcb9]/40 dark:bg-[#584a3b]/40 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={16} className="text-[#a46c24] dark:text-[#f3eadf] shrink-0" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase truncate">
              Run Log · {headerLabel}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-gray-400 dark:text-[#b8ab9f] hover:text-red-500 p-1 rounded-full hover:bg-white dark:hover:bg-[#292119]/60 transition-all cursor-pointer shrink-0"
            title="Close (Esc)"
          >
            <X size={15} />
          </button>
        </div>

        <div className="px-4 py-2 border-b border-[#ebdcb9]/60 dark:border-[#584a3b]/60 flex flex-wrap items-center gap-2 text-[10px] font-mono text-[#8a6e5a] dark:text-[#b8ab9f]">
          {subtitleParts.length > 0 && (
            <span className="px-1.5 py-0.5 rounded-md border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119]">
              {subtitleParts.join(' · ')}
            </span>
          )}
          {logPath && (
            <span className="truncate flex-1 min-w-0" title={logPath}>
              {logPath}
            </span>
          )}
          <span className="shrink-0 ml-auto">
            {sizeLabel} · {lineCount} lines
          </span>
        </div>

        <div className="flex-1 overflow-auto p-4 bg-[#f7f3ea] dark:bg-[#14110d]">
          {loading && (
            <div className="flex items-center justify-center h-full text-[#8a6e5a] dark:text-[#b8ab9f] text-xs font-mono gap-2">
              <Loader2 size={14} className="animate-spin" />
              Loading log…
            </div>
          )}

          {!loading && error && (
            <div className="flex items-center gap-2 text-[#b4432d] dark:text-[#f3eadf] text-xs font-mono">
              <AlertTriangle size={14} />
              {error}
            </div>
          )}

          {!loading && !error && !exists && (
            <div className="flex items-center justify-center h-full text-[#8a6e5a] dark:text-[#b8ab9f] text-xs font-mono">
              No log file for this run yet.
            </div>
          )}

          {!loading && !error && exists && (
            <pre className="text-[11px] font-mono leading-relaxed whitespace-pre-wrap break-words text-[#45372d] dark:text-[#f3eadf]">
              {content && content.length > 0 ? content : '(empty log)'}
            </pre>
          )}
        </div>

        <div className="p-3 bg-[#f4ebd9] dark:bg-[#1e1914] border-t border-[#ebdcb9] dark:border-[#584a3b] flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="text-[10px] font-mono font-extrabold uppercase px-4 py-2 rounded-xl border border-[#ebdcb9] dark:border-[#584a3b] bg-white dark:bg-[#292119] text-[#8a6e5a] dark:text-[#f3eadf] hover:bg-[#fff9ed] dark:hover:bg-[#3a2f26] transition-colors cursor-pointer shadow-3xs"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={loading || !!error || !content}
            className="text-[10px] font-mono font-extrabold uppercase px-4 py-2 rounded-xl bg-[#d89745] dark:bg-[#a46c24] text-white hover:bg-[#c07c28] dark:hover:bg-[#8a581c] transition-colors cursor-pointer shadow-3xs inline-flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy log'}
          </button>
        </div>
      </div>
    </div>
  );
}
