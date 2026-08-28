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
    <div className="df-dialog-backdrop fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in select-text">
      <div className="fixed inset-0" onClick={onClose} />

      <div className="df-dialog relative z-10 flex h-[80vh] w-full max-w-3xl flex-col overflow-hidden font-sans" role="dialog" aria-modal="true" aria-label="Agent run log">
        <div className="df-dialog-header flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-2 min-w-0">
            <FileText size={16} className="text-[#a46c24] dark:text-[#f3eadf] shrink-0" />
            <h2 className="text-xs font-black text-[#5c493c] dark:text-[#f3eadf] tracking-tight uppercase truncate">
              Run Log · {headerLabel}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="df-icon-button shrink-0"
            aria-label="Close agent run log"
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
            <span className="df-break-technical min-w-0 flex-1" title={logPath}>
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
            <div className="df-feedback df-feedback--danger">
              <div className="df-feedback__summary flex items-center gap-2"><AlertTriangle size={14} /> Log unavailable</div>
              <div className="df-feedback__detail df-break-technical">{error}</div>
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

        <div className="df-dialog-footer flex items-center justify-end gap-2 p-3">
          <button
            type="button"
            onClick={onClose}
            className="df-button df-button--secondary font-mono text-[10px] uppercase"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleCopy}
            disabled={loading || !!error || !content}
            className="df-button df-button--primary font-mono text-[10px] uppercase"
          >
            {copied ? <Check size={12} /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy log'}
          </button>
        </div>
      </div>
    </div>
  );
}
