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
      if (!response.ok) {
        throw new Error(`Settings save failed with status ${response.status}`);
      }
      if (newValue) {
        setPreflightError(null);
      }
    } catch (err) {
      console.error('Failed to save autoWork setting:', err);
      setAutoWork(!newValue); // Revert on failure
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#fdfbf6] dark:bg-[#292119] border border-[#e5d4bb] dark:border-[#584a3b] rounded-xl h-[34px]">
        <Loader2 size={12} className="text-[#d89745] dark:text-[#e0a070] animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div 
        className="flex items-center gap-2 px-3 py-1.5 bg-[#fdfbf6] dark:bg-[#292119] border border-[#e5d4bb] dark:border-[#584a3b] rounded-xl shadow-2xs h-[34px] cursor-pointer hover:bg-[#faf7f0] dark:hover:bg-[#1e1914] transition-colors"
        onClick={toggleAutoWork}
        title="Automatically trigger agents when a task is moved to the 'Ready To Do' (todo) lane"
      >
        <span className="text-[10px] font-bold font-mono text-[#a46c24] dark:text-[#f3eadf] select-none">
          Auto Work
        </span>
        <button
          className={`flex items-center p-0.5 rounded-full transition-colors w-7 border ${
            autoWork 
              ? 'bg-[#d89745] dark:bg-[#e0a070] border-[#c07c28] dark:border-[#584a3b] justify-end' 
              : 'bg-[#ebe5da] dark:bg-[#292119] border-[#ddd0ba] dark:border-[#584a3b] justify-start'
          }`}
        >
          <div className="w-3.5 h-3.5 rounded-full bg-white dark:bg-[#292119] shadow-sm" />
        </button>
      </div>

      {preflightError && (
        <div className="max-w-[260px] flex items-start gap-1.5 px-2 py-1 rounded-lg border border-[#f0c48f] dark:border-[#584a3b] bg-[#fff7eb] dark:bg-[#292119] text-[10px] font-mono font-bold text-[#9a5b13] dark:text-[#f3eadf]">
          <AlertTriangle size={11} className="shrink-0 mt-[1px]" />
          <span>{preflightError}</span>
        </div>
      )}
    </div>
  );
}
