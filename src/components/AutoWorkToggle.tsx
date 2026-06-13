import { useState, useEffect } from 'react';
import { Loader2 } from 'lucide-react';

export default function AutoWorkToggle() {
  const [autoWork, setAutoWork] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.json())
      .then(data => {
        setAutoWork(!!data.autoWork);
      })
      .catch(err => console.error('Failed to load autoWork setting:', err))
      .finally(() => setLoading(false));
  }, []);

  const toggleAutoWork = async () => {
    if (saving) return;
    const newValue = !autoWork;
    setAutoWork(newValue);
    setSaving(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoWork: newValue })
      });
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
        <Loader2 size={12} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] animate-spin" />
      </div>
    );
  }

  return (
    <div 
      className="flex items-center gap-2 px-3 py-1.5 bg-[#fdfbf6] dark:bg-[#292119] border border-[#e5d4bb] dark:border-[#584a3b] rounded-xl shadow-2xs h-[34px] cursor-pointer hover:bg-[#faf7f0] dark:bg-[#1e1914] dark:hover:bg-[#1e1914] transition-colors"
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
  );
}
