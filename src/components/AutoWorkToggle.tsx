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
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[#fdfbf6] border border-[#e5d4bb] rounded-xl h-[34px]">
        <Loader2 size={12} className="text-[#d89745] animate-spin" />
      </div>
    );
  }

  return (
    <div 
      className="flex items-center gap-2 px-3 py-1.5 bg-[#fdfbf6] border border-[#e5d4bb] rounded-xl shadow-2xs h-[34px] cursor-pointer hover:bg-[#faf7f0] transition-colors"
      onClick={toggleAutoWork}
      title="Automatically trigger agents when a task is moved to the 'Ready To Do' (todo) lane"
    >
      <span className="text-[10px] font-bold font-mono text-[#a46c24] select-none">
        Auto Work
      </span>
      <button
        className={`flex items-center p-0.5 rounded-full transition-colors w-7 border ${
          autoWork 
            ? 'bg-[#d89745] border-[#c07c28] justify-end' 
            : 'bg-[#ebe5da] border-[#ddd0ba] justify-start'
        }`}
      >
        <div className="w-3.5 h-3.5 rounded-full bg-white shadow-sm" />
      </button>
    </div>
  );
}
