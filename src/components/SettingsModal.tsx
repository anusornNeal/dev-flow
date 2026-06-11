import React, { useState, useEffect } from 'react';
import { X, Link, FileText, ToggleLeft, ToggleRight, Save, Loader2, CheckCircle2, AlertCircle } from 'lucide-react';

interface SettingsData {
  autoWorking: boolean;
  ngrokUrl: string;
  envNotesMasked: boolean;
  envNotesLength: number;
}

interface SettingsModalProps {
  onClose: () => void;
  autoWorking: boolean;
  onToggleAutoWorking: () => void;
}

export default function SettingsModal({ onClose, autoWorking, onToggleAutoWorking }: SettingsModalProps) {
  const [ngrokUrl, setNgrokUrl] = useState('');
  const [envNotes, setEnvNotes] = useState('');
  const [envNotesMasked, setEnvNotesMasked] = useState(false);
  const [envNotesLength, setEnvNotesLength] = useState(0);
  const [showEnvNotes, setShowEnvNotes] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: SettingsData) => {
        setNgrokUrl(data.ngrokUrl ?? '');
        setEnvNotesMasked(data.envNotesMasked ?? false);
        setEnvNotesLength(data.envNotesLength ?? 0);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const payload: Record<string, unknown> = { ngrokUrl };
      if (showEnvNotes) payload.envNotes = envNotes;

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error ?? 'Save failed');
      }
      setSaveStatus('success');
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Failed to save');
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] rounded-2xl shadow-xl w-full max-w-xl border border-[#e5d4bb] overflow-hidden">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#ebdcb9] bg-[#fdfbf6] flex items-center justify-between">
          <h2 className="text-[#534135] font-extrabold font-sans text-lg">⚙️ Settings</h2>
          <button
            onClick={onClose}
            className="text-[#8c7463] hover:bg-[#ebdcb9]/40 p-1.5 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-16">
            <Loader2 size={24} className="text-[#d89745] animate-spin" />
          </div>
        ) : (
          <div className="p-6 flex flex-col gap-6">

            {/* Auto Working Toggle */}
            <div className="flex items-center justify-between p-4 bg-[#faf7f0] border border-[#e5d4bb] rounded-xl">
              <div>
                <div className="font-extrabold text-sm text-[#534135]">Auto Working</div>
                <div className="text-[11px] text-[#8a725f] font-mono mt-0.5">
                  Automatically pick up ready-to-do tasks in the queue
                </div>
              </div>
              <button
                onClick={onToggleAutoWorking}
                className="transition-colors"
                title={autoWorking ? 'Disable auto working' : 'Enable auto working'}
              >
                {autoWorking
                  ? <ToggleRight size={34} className="text-[#d89745]" />
                  : <ToggleLeft size={34} className="text-[#c4a991]" />
                }
              </button>
            </div>

            {/* ngrok URL */}
            <div className="flex flex-col gap-2">
              <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135]">
                <Link size={14} className="text-[#d89745]" />
                ngrok URL
              </label>
              <p className="text-[11px] text-[#8a725f] font-mono -mt-1">
                The public ngrok tunnel URL used by agents to reach this DevFlow instance remotely.
              </p>
              <input
                type="url"
                value={ngrokUrl}
                onChange={e => setNgrokUrl(e.target.value)}
                placeholder="https://xxxx.ngrok-free.app"
                className="w-full px-4 py-2.5 text-sm font-mono rounded-xl border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
              />
            </div>

            {/* Env Notes (masked) */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135]">
                  <FileText size={14} className="text-[#d89745]" />
                  Environment Notes
                  {envNotesMasked && !showEnvNotes && (
                    <span className="ml-1 text-[10px] bg-[#fde9c4] text-[#a0671a] px-2 py-0.5 rounded-full font-bold">
                      {envNotesLength} chars stored
                    </span>
                  )}
                </label>
                <button
                  onClick={() => {
                    setShowEnvNotes(v => !v);
                    if (!showEnvNotes) setEnvNotes('');
                  }}
                  className="text-[10px] text-[#d89745] font-bold hover:underline"
                >
                  {showEnvNotes ? 'Cancel edit' : envNotesMasked ? 'Replace' : 'Add'}
                </button>
              </div>
              <p className="text-[11px] text-[#8a725f] font-mono -mt-1">
                Optional plain-text notes for local startup env values (e.g. GEMINI_API_KEY). Not shown in logs.
              </p>
              {showEnvNotes ? (
                <textarea
                  value={envNotes}
                  onChange={e => setEnvNotes(e.target.value)}
                  placeholder={"GEMINI_API_KEY=your-key-here\nOTHER_VAR=value"}
                  rows={5}
                  className="w-full px-4 py-2.5 text-sm font-mono rounded-xl border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition resize-none"
                />
              ) : (
                <div className="px-4 py-3 rounded-xl border border-[#e5d4bb] bg-[#faf7f0] text-[11px] text-[#b89b82] font-mono">
                  {envNotesMasked
                    ? '••••••••••••••••••••••••••••••••••••••'
                    : 'No environment notes stored.'
                  }
                </div>
              )}
            </div>

            {/* Save Button */}
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center gap-1.5 text-xs font-mono">
                {saveStatus === 'success' && (
                  <><CheckCircle2 size={14} className="text-green-500" /><span className="text-green-600">Saved successfully</span></>
                )}
                {saveStatus === 'error' && (
                  <><AlertCircle size={14} className="text-red-400" /><span className="text-red-500">{errorMsg}</span></>
                )}
              </div>
              <button
                onClick={handleSave}
                disabled={saving}
                className="bg-[#d89745] hover:bg-[#c07c28] text-white px-5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors shadow-sm disabled:opacity-50"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
