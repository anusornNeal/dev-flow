import React, { useState, useEffect } from 'react';
import { X, Link, FileText, ToggleLeft, ToggleRight, Save, Loader2, CheckCircle2, AlertCircle, Database, Download } from 'lucide-react';

interface SettingsData {
  ngrokUrl: string;
  githubTokenMasked: boolean;
  jiraTokenMasked: boolean;
  jiraBaseUrl: string;
  jiraEmail: string;
}

interface SettingsModalProps {
  onClose: () => void;
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [ngrokUrl, setNgrokUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubTokenMasked, setGithubTokenMasked] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);
  
  const [jiraToken, setJiraToken] = useState('');
  const [jiraTokenMasked, setJiraTokenMasked] = useState(false);
  const [showJiraToken, setShowJiraToken] = useState(false);
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: SettingsData) => {
        setNgrokUrl(data.ngrokUrl ?? '');
        setGithubTokenMasked(data.githubTokenMasked ?? false);
        setJiraTokenMasked(data.jiraTokenMasked ?? false);
        setJiraBaseUrl(data.jiraBaseUrl ?? '');
        setJiraEmail(data.jiraEmail ?? '');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const payload: Record<string, unknown> = { ngrokUrl, jiraBaseUrl, jiraEmail };
      if (showGithubToken) payload.githubToken = githubToken;
      if (showJiraToken) payload.jiraToken = jiraToken;

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


            {/* Integrations Section */}
            <div className="flex flex-col gap-5 border border-[#e5d4bb] rounded-xl p-4 bg-[#fdfbf6]">
              <div>
                <h3 className="text-sm font-extrabold text-[#534135] flex items-center gap-1.5 mb-1">
                  <FileText size={14} className="text-[#d89745]" />
                  Integrations
                </h3>
                <p className="text-[11px] text-[#8a725f] font-mono">
                  Configure external API credentials for GitHub and Jira.
                </p>
              </div>

              {/* GitHub Token (masked) */}
              <div className="flex flex-col gap-1.5 pt-2 border-t border-[#ebdcb9]">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-bold text-[#685547]">GitHub Access Token</label>
                  <button
                    onClick={() => {
                      setShowGithubToken(v => !v);
                      if (!showGithubToken) setGithubToken('');
                    }}
                    className="text-[10px] text-[#d89745] font-bold hover:underline"
                  >
                    {showGithubToken ? 'Cancel edit' : githubTokenMasked ? 'Replace' : 'Add'}
                  </button>
                </div>
                <p className="text-[11px] text-[#8a725f] font-mono -mt-1">
                  Securely stored token for GitHub API integrations. Not shown in logs.
                </p>
                {showGithubToken ? (
                  <input
                    type="password"
                    value={githubToken}
                    onChange={e => setGithubToken(e.target.value)}
                    placeholder="ghp_..."
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                  />
                ) : (
                  <div className="px-3 py-2 rounded-lg border border-[#e5d4bb] bg-[#faf7f0] text-[11px] text-[#b89b82] font-mono">
                    {githubTokenMasked
                      ? 'Token securely stored.'
                      : 'No GitHub token stored.'
                    }
                  </div>
                )}
              </div>

              {/* Jira Integration Section */}
              <div className="flex flex-col gap-3 pt-3 border-t border-[#ebdcb9]">
                <div className="flex flex-col gap-1">
                  <label className="text-xs font-bold text-[#685547]">Jira Integration</label>
                </div>

                {/* Jira Base URL */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[10px] font-bold text-[#8a725f] uppercase tracking-wider">Base URL</label>
                  <input
                    type="url"
                    value={jiraBaseUrl}
                    onChange={e => setJiraBaseUrl(e.target.value)}
                    placeholder="https://your-domain.atlassian.net"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                  />
                </div>

                {/* Jira Email */}
                <div className="flex flex-col gap-1.5 mt-1">
                  <label className="text-[10px] font-bold text-[#8a725f] uppercase tracking-wider">Email</label>
                  <input
                    type="email"
                    value={jiraEmail}
                    onChange={e => setJiraEmail(e.target.value)}
                    placeholder="name@company.com"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                  />
                </div>

                {/* Jira Token (masked) */}
                <div className="flex flex-col gap-1.5 mt-1">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-bold text-[#8a725f] uppercase tracking-wider">Access Token</label>
                    <button
                      onClick={() => {
                        setShowJiraToken(v => !v);
                        if (!showJiraToken) setJiraToken('');
                      }}
                      className="text-[10px] text-[#d89745] font-bold hover:underline"
                    >
                      {showJiraToken ? 'Cancel edit' : jiraTokenMasked ? 'Replace' : 'Add'}
                    </button>
                  </div>
                  {showJiraToken ? (
                    <input
                      type="password"
                      value={jiraToken}
                      onChange={e => setJiraToken(e.target.value)}
                      placeholder="Jira token..."
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                    />
                  ) : (
                    <div className="px-3 py-2 rounded-lg border border-[#e5d4bb] bg-[#faf7f0] text-[11px] text-[#b89b82] font-mono">
                      {jiraTokenMasked
                        ? 'Token securely stored.'
                        : 'No Jira token stored.'
                      }
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Export Data */}
            <div className="pt-4 mt-2 border-t border-[#ebdcb9] flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135]">
                    <Database size={14} className="text-[#d89745]" />
                    Export Data
                  </label>
                  <p className="text-[11px] text-[#8a725f] font-mono mt-0.5">
                    Download a portable backup of your DevFlow data (projects, tasks, skills) to migrate to another machine. Secrets are excluded.
                  </p>
                </div>
                <button
                  onClick={() => window.location.href = '/api/export'}
                  type="button"
                  className="bg-[#faf7f0] border border-[#e5d4bb] hover:bg-[#ebdcb9] text-[#534135] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap"
                >
                  <Download size={14} /> Export Backup
                </button>
              </div>
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
