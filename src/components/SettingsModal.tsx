import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Save, X } from 'lucide-react';
import AgentExecutionModeSection from './settings/AgentExecutionModeSection';
import BackupSettingsSection from './settings/BackupSettingsSection';
import IntegrationsSettingsSection from './settings/IntegrationsSettingsSection';
import NgrokSettingsSection from './settings/NgrokSettingsSection';

interface SettingsData {
  ngrokUrl: string;
  githubTokenMasked: boolean;
  jiraTokenMasked: boolean;
  figmaTokenMasked: boolean;
  jiraBaseUrl: string;
  jiraEmail: string;
  agentExecutionMode: string;
}

interface SettingsModalProps {
  onClose: () => void;
}

type SaveStatus = 'idle' | 'success' | 'error';
type ImportStatus = 'idle' | 'importing' | 'success' | 'error';

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [ngrokUrl, setNgrokUrl] = useState('');
  const [githubToken, setGithubToken] = useState('');
  const [githubTokenMasked, setGithubTokenMasked] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);

  const [jiraToken, setJiraToken] = useState('');
  const [jiraTokenMasked, setJiraTokenMasked] = useState(false);
  const [showJiraToken, setShowJiraToken] = useState(false);
  const [figmaToken, setFigmaToken] = useState('');
  const [figmaTokenMasked, setFigmaTokenMasked] = useState(false);
  const [showFigmaToken, setShowFigmaToken] = useState(false);
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [agentExecutionMode, setAgentExecutionMode] = useState('safe');

  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [clearJiraToken, setClearJiraToken] = useState(false);
  const [clearFigmaToken, setClearFigmaToken] = useState(false);

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [importMsg, setImportMsg] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch('/api/settings', { cache: 'no-store' })
      .then(response => response.json())
      .then((data: SettingsData) => {
        setNgrokUrl(data.ngrokUrl ?? '');
        setGithubTokenMasked(data.githubTokenMasked ?? false);
        setJiraTokenMasked(data.jiraTokenMasked ?? false);
        setFigmaTokenMasked(data.figmaTokenMasked ?? false);
        setJiraBaseUrl(data.jiraBaseUrl ?? '');
        setJiraEmail(data.jiraEmail ?? '');
        setAgentExecutionMode(data.agentExecutionMode || 'safe');
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const applySavedTokenState = ({
    token,
    showToken,
    clearToken,
    setToken,
    setMasked,
    setShowToken,
    setClearToken,
  }: {
    token: string;
    showToken: boolean;
    clearToken: boolean;
    setToken: (value: string) => void;
    setMasked: (value: boolean) => void;
    setShowToken: (value: boolean) => void;
    setClearToken: (value: boolean) => void;
  }) => {
    if (showToken && token.trim() !== '') {
      setMasked(true);
      setShowToken(false);
      setToken('');
    }

    if (clearToken) {
      setMasked(false);
      setClearToken(false);
    }
  };

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

      if (showFigmaToken && figmaToken.trim() !== '') {
        payload.figmaToken = figmaToken;
      } else if (clearFigmaToken) {
        payload.figmaToken = '';
        payload.clearFigmaToken = true;
      }

      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error ?? 'Save failed');
      }

      setSaveStatus('success');
      applySavedTokenState({
        token: githubToken,
        showToken: showGithubToken,
        clearToken: clearGithubToken,
        setToken: setGithubToken,
        setMasked: setGithubTokenMasked,
        setShowToken: setShowGithubToken,
        setClearToken: setClearGithubToken,
      });
      applySavedTokenState({
        token: jiraToken,
        showToken: showJiraToken,
        clearToken: clearJiraToken,
        setToken: setJiraToken,
        setMasked: setJiraTokenMasked,
        setShowToken: setShowJiraToken,
        setClearToken: setClearJiraToken,
      });
      applySavedTokenState({
        token: figmaToken,
        showToken: showFigmaToken,
        clearToken: clearFigmaToken,
        setToken: setFigmaToken,
        setMasked: setFigmaTokenMasked,
        setShowToken: setShowFigmaToken,
        setClearToken: setClearFigmaToken,
      });
      setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error: any) {
      setErrorMsg(error.message ?? 'Failed to save');
      setSaveStatus('error');
    } finally {
      setSaving(false);
    }
  };

  const handleImportFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!window.confirm('Are you sure you want to restore from this backup? Your current DevFlow database will be overwritten. A safety backup will be created.')) {
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    setImportStatus('importing');
    setImportMsg('');

    try {
      const response = await fetch('/api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: file,
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? 'Import failed');
      }

      setImportStatus('success');
      const countsStr = data.counts ? ` (Projects: ${data.counts.projects || 0}, Tasks: ${data.counts.tasks || 0})` : '';
      setImportMsg(`Import completed${countsStr}. Please restart DevFlow.`);
    } catch (error: any) {
      setImportStatus('error');
      setImportMsg(error.message ?? 'Failed to import backup');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="fixed inset-0 bg-[#3e3129]/30 dark:bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-[#fffdfa] dark:bg-[#1e1914] rounded-2xl shadow-xl w-full max-w-xl border border-[#e5d4bb] dark:border-[#584a3b] overflow-hidden flex flex-col max-h-[90vh]">
        <div className="px-6 py-4 border-b border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#1e1914] flex items-center justify-between shrink-0">
          <h2 className="text-[#534135] dark:text-[#f3eadf] font-extrabold font-sans text-lg">⚙️ Settings</h2>
          <button
            onClick={onClose}
            className="text-[#8c7463] dark:text-[#f3eadf] hover:bg-[#ebdcb9] dark:bg-[#584a3b]/40 dark:hover:bg-[#584a3b]/40 p-1.5 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-center p-16">
            <Loader2 size={24} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d] animate-spin" />
          </div>
        ) : (
          <>
            <div className="p-6 flex flex-col gap-6 overflow-y-auto min-h-0">
              <NgrokSettingsSection ngrokUrl={ngrokUrl} onNgrokUrlChange={setNgrokUrl} />
              <IntegrationsSettingsSection
                githubToken={{
                  value: githubToken,
                  masked: githubTokenMasked,
                  show: showGithubToken,
                  clear: clearGithubToken,
                  onValueChange: setGithubToken,
                  onShowChange: setShowGithubToken,
                  onClearChange: setClearGithubToken,
                }}
                jiraToken={{
                  value: jiraToken,
                  masked: jiraTokenMasked,
                  show: showJiraToken,
                  clear: clearJiraToken,
                  onValueChange: setJiraToken,
                  onShowChange: setShowJiraToken,
                  onClearChange: setClearJiraToken,
                }}
                figmaToken={{
                  value: figmaToken,
                  masked: figmaTokenMasked,
                  show: showFigmaToken,
                  clear: clearFigmaToken,
                  onValueChange: setFigmaToken,
                  onShowChange: setShowFigmaToken,
                  onClearChange: setClearFigmaToken,
                }}
                jiraBaseUrl={jiraBaseUrl}
                jiraEmail={jiraEmail}
                onJiraBaseUrlChange={setJiraBaseUrl}
                onJiraEmailChange={setJiraEmail}
              />
              <AgentExecutionModeSection
                agentExecutionMode={agentExecutionMode}
                onAgentExecutionModeChange={setAgentExecutionMode}
              />
              <BackupSettingsSection
                fileInputRef={fileInputRef}
                importStatus={importStatus}
                importMsg={importMsg}
                onImportFile={handleImportFile}
              />
            </div>

            <div className="px-6 py-4 border-t border-[#ebdcb9] dark:border-[#584a3b] bg-[#fdfbf6] dark:bg-[#1e1914] flex items-center justify-between shrink-0">
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
                className="bg-[#d89745] dark:bg-[#e0a070] hover:bg-[#c07c28] dark:bg-[#e0a070] dark:hover:bg-[#d6b56d] dark:bg-[#e0a070] text-white dark:text-[#f3eadf] px-5 py-2 rounded-xl text-sm font-bold flex items-center gap-2 transition-colors shadow-sm disabled:opacity-50"
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
