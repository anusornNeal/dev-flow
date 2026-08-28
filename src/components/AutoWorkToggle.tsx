import { useState, useEffect } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';

export default function AutoWorkToggle() {
  const [autoWork, setAutoWork] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [preflightError, setPreflightError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setAutoWork(!!data.autoWork);
      })
      .catch(err => console.error('Failed to load autoWork setting:', err))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const handlePreflightError = (event: Event) => {
      const detail = (event as CustomEvent<{ message?: string }>).detail;
      setPreflightError(detail?.message || 'Auto Work blocked before launch.');
    };

    window.addEventListener('devflow:auto-work-preflight-error', handlePreflightError);
    return () => window.removeEventListener('devflow:auto-work-preflight-error', handlePreflightError);
  }, []);

  const toggleAutoWork = async () => {
    if (saving) return;
    const newValue = !autoWork;
    setAutoWork(newValue);
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoWork: newValue })
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const errorMessage = body?.error?.message || (typeof body?.error === 'string' ? body.error : null) || `Settings save failed with status ${response.status}`;
        throw new Error(errorMessage);
      }
      if (newValue) {
        if (body?.autoWorkTrigger && !body.autoWorkTrigger.triggered && body.autoWorkTrigger.reason !== 'No eligible todo tasks found.') {
          setPreflightError(body.autoWorkTrigger.reason);
        } else {
          setPreflightError(null);
        }
      } else {
        setPreflightError(null);
      }
    } catch (err) {
      console.error('Failed to save autoWork setting:', err);
      if (newValue) {
        setPreflightError(err instanceof Error ? err.message : 'Auto Work could not be enabled.');
      }
      setAutoWork(!newValue);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="df-control flex h-[34px] min-h-[34px] items-center gap-2 px-3" role="status" aria-label="Loading Auto Work setting">
        <Loader2 size={12} className="animate-spin text-df-accent" />
        <span className="df-meta">Auto Work</span>
      </div>
    );
  }

  return (
    <div className="flex max-w-[280px] flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={autoWork}
        disabled={saving}
        onClick={toggleAutoWork}
        className="df-control flex h-[34px] min-h-[34px] items-center gap-2 px-3 shadow-[var(--df-shadow-sm)]"
        title="Automatically trigger agents when a task is moved to the 'Ready To Do' (todo) lane"
      >
        <span className="flex select-none items-center gap-1 font-mono text-[10px] font-bold text-df-text">
          {saving && <Loader2 size={10} className="animate-spin" />}
          Auto Work
        </span>
        <span
          aria-hidden="true"
          className={`flex w-7 items-center rounded-full border p-0.5 transition-colors ${
            autoWork
              ? 'justify-end border-df-accent bg-df-accent'
              : 'justify-start border-df-border bg-df-surface-muted'
          }`}
        >
          <span className="h-3.5 w-3.5 rounded-full bg-df-surface-raised shadow-sm" />
        </span>
      </button>

      {preflightError && (
        <div className="df-feedback df-feedback--warning max-w-[280px]" role="alert">
          <div className="df-feedback__summary flex items-center gap-1.5">
            <AlertTriangle size={11} className="shrink-0" />
            Auto Work blocked
          </div>
          <div className="df-feedback__detail df-break-technical">{preflightError}</div>
        </div>
      )}
    </div>
  );
}
