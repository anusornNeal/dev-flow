import React, { useState, useEffect } from 'react';
import { X, Link, FileText, ToggleLeft, ToggleRight, Save, Loader2, CheckCircle2, AlertCircle, Database, Download, Activity, Upload } from 'lucide-react';

interface SettingsData {
  ngrokUrl: string;
  githubTokenMasked: boolean;
  jiraTokenMasked: boolean;
  jiraBaseUrl: string;
  jiraEmail: string;
  agentExecutionMode: string;
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
  const [agentExecutionMode, setAgentExecutionMode] = useState('safe');
  
  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [clearJiraToken, setClearJiraToken] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const [importStatus, setImportStatus] = useState<'idle' | 'importing' | 'success' | 'error'>('idle');
  const [importMsg, setImportMsg] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(r => r.json())
      .then((data: SettingsData) => {
        setNgrokUrl(data.ngrokUrl ?? '');
        setGithubTokenMasked(data.githubTokenMasked ?? false);
        setJiraTokenMasked(data.jiraTokenMasked ?? false);
        setJiraBaseUrl(data.jiraBaseUrl ?? '');
        setJiraEmail(data.jiraEmail ?? '');
        setAgentExecutionMode(data.agentExecutionMode || 'safe');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveStatus('idle');
    try {
      const payload: Record<string, unknown> = { ngrokUrl, jiraBaseUrl, jiraEmail, agentExecutionMode };
      if (showGithubToken && githubToken.trim() !== '') {
        payload.githubToken = githubToken;
      } else if (clearGithubToken) {
        payload.githubToken = '';
        payload.clearGithubToken = true;
      }

      if (showJiraToken && jiraToken.trim() !== '') {
        payload.jiraToken = jiraToken;
      } else if (clearJiraToken) {
        payload.jiraToken = '';
        payload.clearJiraToken = true;
      }

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
      if (showGithubToken && githubToken.trim() !== '') {
        setGithubTokenMasked(true);
        setShowGithubToken(false);
        setGithubToken('');
      }
      if (clearGithubToken) {
        setGithubTokenMasked(false);
        setClearGithubToken(false);
      }
      
      if (showJiraToken && jiraToken.trim() !== '') {
        setJiraTokenMasked(true);
        setShowJiraToken(false);
        setJiraToken('');
      }
      if (clearJiraToken) {
        setJiraTokenMasked(false);
        setClearJiraToken(false);
      }
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (e: any) {
      setErrorMsg(e.message ?? 'Failed to save');
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!window.confirm('Are you sure you want to restore from this backup? Your current DevFlow database will be overwritten. A safety backup will be created.')) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setImportStatus('importing');
    setImportMsg('');

    try {
      const res = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error ?? 'Import failed');
      }

      setImportStatus('success');
      const countsStr = data.counts ? ` (Projects: ${data.counts.projects || 0}, Tasks: ${data.counts.tasks || 0})` : '';
      setImportMsg(`Import completed${countsStr}. Please restart DevFlow.`);
    } catch (err: any) {
      setImportStatus('error');
      setImportMsg(err.message ?? 'Failed to import backup');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] rounded-2xl shadow-xl w-full max-w-xl border border-[#e5d4bb] overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="px-6 py-4 border-b border-[#ebdcb9] bg-[#fdfbf6] flex items-center justify-between shrink-0">
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
          <>
            <div className="p-6 flex flex-col gap-6 overflow-y-auto min-h-0">

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
                  <div className="flex gap-2">
                    {githubTokenMasked && !showGithubToken && !clearGithubToken && (
                      <button
                        onClick={() => {
                          setClearGithubToken(true);
                        }}
                        className="text-[10px] text-red-500 font-bold hover:underline"
                      >
                        Remove
                      </button>
                    )}
                    {!clearGithubToken && (
                      <button
                        onClick={() => {
                          if (showGithubToken) {
                            setShowGithubToken(false);
                            setGithubToken('');
                          } else {
                            setShowGithubToken(true);
                          }
                        }}
                        className="text-[10px] text-[#d89745] font-bold hover:underline"
                      >
                        {showGithubToken ? 'Cancel' : githubTokenMasked ? 'Replace' : 'Add'}
                      </button>
                    )}
                  </div>
                </div>
                <p className="text-[11px] text-[#8a725f] font-mono -mt-1">
                  Securely stored token for GitHub API integrations. Not shown in logs.
                </p>
                {showGithubToken ? (
                  <input
                    type="password"
                    name="githubToken_devflow_prevent_autofill"
                    autoComplete="new-password"
                    value={githubToken}
                    onChange={e => setGithubToken(e.target.value)}
                    placeholder="ghp_..."
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                  />
                ) : clearGithubToken ? (
                  <div className="px-3 py-2 rounded-lg border border-[#fecaca] bg-[#fff0f0] text-[11px] text-[#991b1b] font-mono flex items-center justify-between">
                    Pending removal (Save to apply)
                    <button onClick={() => setClearGithubToken(false)} className="underline hover:text-[#7f1d1d] font-bold">Undo</button>
                  </div>
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
                    <div className="flex gap-2">
                      {jiraTokenMasked && !showJiraToken && !clearJiraToken && (
                        <button
                          onClick={() => {
                            setClearJiraToken(true);
                          }}
                          className="text-[10px] text-red-500 font-bold hover:underline"
                        >
                          Remove
                        </button>
                      )}
                      {!clearJiraToken && (
                        <button
                          onClick={() => {
                            if (showJiraToken) {
                              setShowJiraToken(false);
                              setJiraToken('');
                            } else {
                              setShowJiraToken(true);
                            }
                          }}
                          className="text-[10px] text-[#d89745] font-bold hover:underline"
                        >
                          {showJiraToken ? 'Cancel' : jiraTokenMasked ? 'Replace' : 'Add'}
                        </button>
                      )}
                    </div>
                  </div>
                  {showJiraToken ? (
                    <input
                      type="password"
                      name="jiraToken_devflow_prevent_autofill"
                      autoComplete="new-password"
                      value={jiraToken}
                      onChange={e => setJiraToken(e.target.value)}
                      placeholder="Jira token..."
                      className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] bg-white text-[#3e3129] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 focus:border-[#d89745] transition"
                    />
                  ) : clearJiraToken ? (
                    <div className="px-3 py-2 rounded-lg border border-[#fecaca] bg-[#fff0f0] text-[11px] text-[#991b1b] font-mono flex items-center justify-between">
                      Pending removal (Save to apply)
                      <button onClick={() => setClearJiraToken(false)} className="underline hover:text-[#7f1d1d] font-bold">Undo</button>
                    </div>
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

            {/* Agent Execution Mode */}
            <div className="pt-4 mt-2 border-t border-[#ebdcb9] flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135]">
                  <Activity size={14} className="text-[#d89745]" />
                  Agent Execution Mode
                </label>
                <p className="text-[11px] text-[#8a725f] font-mono leading-relaxed">
                  Controls the permissions granted to agents when DevFlow auto-triggers runs.
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${agentExecutionMode === 'safe' ? 'bg-[#f0f9f4] border-[#a3e6cd] shadow-sm' : 'bg-white border-[#ebdcb9] hover:bg-[#faf7f0]'}`}>
                  <input type="radio" name="executionMode" value="safe" checked={agentExecutionMode === 'safe'} onChange={() => setAgentExecutionMode('safe')} className="mt-1" />
                  <div className="flex flex-col">
                    <span className={`text-[12px] font-bold ${agentExecutionMode === 'safe' ? 'text-[#166534]' : 'text-[#534135]'}`}>Safe Mode (Recommended)</span>
                    <span className="text-[10px] text-[#8a725f] font-mono">Restricts agents to editing files within the workspace. Blocks arbitrary system commands.</span>
                  </div>
                </label>
                <label className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${agentExecutionMode === 'full' ? 'bg-[#fff0f0] border-[#fecaca] shadow-sm' : 'bg-white border-[#ebdcb9] hover:bg-[#faf7f0]'}`}>
                  <input type="radio" name="executionMode" value="full" checked={agentExecutionMode === 'full'} onChange={() => setAgentExecutionMode('full')} className="mt-1" />
                  <div className="flex flex-col">
                    <span className={`text-[12px] font-bold ${agentExecutionMode === 'full' ? 'text-[#991b1b]' : 'text-[#534135]'}`}>Full Mode</span>
                    <span className="text-[10px] text-[#8a725f] font-mono">Grants broader permissions. Agents may run arbitrary system commands depending on their config.</span>
                  </div>
                </label>
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
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                    disabled={importStatus === 'importing'}
                    className="bg-[#faf7f0] border border-[#e5d4bb] hover:bg-[#ebdcb9] text-[#534135] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap disabled:opacity-50"
                  >
                    {importStatus === 'importing' ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} 
                    {importStatus === 'importing' ? 'Importing...' : 'Import Backup'}
                  </button>
                  <button
                    onClick={() => window.location.href = '/api/export'}
                    type="button"
                    className="bg-[#faf7f0] border border-[#e5d4bb] hover:bg-[#ebdcb9] text-[#534135] px-3 py-1.5 rounded-xl text-xs font-bold transition-colors flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <Download size={14} /> Export Backup
                  </button>
                  <input
                    type="file"
                    accept=".db"
                    ref={fileInputRef}
                    onChange={handleImportFile}
                    className="hidden"
                  />
                </div>
              </div>
              
              {/* Import Messages */}
              {importMsg && (
                <div className={`mt-2 p-2 rounded-lg text-xs font-mono flex items-start gap-2 ${importStatus === 'error' ? 'bg-[#fff0f0] text-[#991b1b] border border-[#fecaca]' : 'bg-[#f0f9f4] text-[#166534] border border-[#a3e6cd]'}`}>
                  {importStatus === 'error' ? <AlertCircle size={14} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={14} className="mt-0.5 shrink-0" />}
                  <span>{importMsg}</span>
                </div>
              )}
            </div>

            </div>
            
            {/* Save Button Footer */}
            <div className="px-6 py-4 border-t border-[#ebdcb9] bg-[#fdfbf6] flex items-center justify-between shrink-0">
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
          </>
        )}
      </div>
    </div>
  );
}
