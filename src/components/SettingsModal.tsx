import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Cable, Database, Loader2, Network, Save, Settings2, X, Zap } from 'lucide-react';
import AgentExecutionModeSection from './settings/AgentExecutionModeSection';
import BackupSettingsSection from './settings/BackupSettingsSection';
import IntegrationsSettingsSection from './settings/IntegrationsSettingsSection';

interface SettingsData {
  githubTokenMasked: boolean;
  jiraTokenMasked: boolean;
  figmaTokenMasked: boolean;
  openAiRuntimeApiKeyMasked: boolean;
  openAiTunnelId: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  agentExecutionMode: string;
}

interface SettingsModalProps {
  onClose: () => void;
}

type SaveStatus = 'idle' | 'success' | 'error';
type ImportStatus = 'idle' | 'importing' | 'success' | 'error';
type SettingsSectionId = 'runtime' | 'integrations' | 'agents' | 'backup';

const SETTINGS_SECTIONS: Array<{
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: typeof Network;
}> = [
  { id: 'runtime', label: 'Runtime', description: 'Tunnel & API key', icon: Network },
  { id: 'integrations', label: 'Integrations', description: 'GitHub, Jira, Figma', icon: Cable },
  { id: 'agents', label: 'Agent execution', description: 'Permission mode', icon: Zap },
  { id: 'backup', label: 'Backup & recovery', description: 'Export, restore, drills', icon: Database },
];

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('runtime');

  const [githubToken, setGithubToken] = useState('');
  const [githubTokenMasked, setGithubTokenMasked] = useState(false);
  const [showGithubToken, setShowGithubToken] = useState(false);

  const [jiraToken, setJiraToken] = useState('');
  const [jiraTokenMasked, setJiraTokenMasked] = useState(false);
  const [showJiraToken, setShowJiraToken] = useState(false);

  const [figmaToken, setFigmaToken] = useState('');
  const [figmaTokenMasked, setFigmaTokenMasked] = useState(false);
  const [showFigmaToken, setShowFigmaToken] = useState(false);

  const [openAiRuntimeApiKey, setOpenAiRuntimeApiKey] = useState('');
  const [openAiRuntimeApiKeyMasked, setOpenAiRuntimeApiKeyMasked] = useState(false);
  const [showOpenAiRuntimeApiKey, setShowOpenAiRuntimeApiKey] = useState(false);

  const [openAiTunnelId, setOpenAiTunnelId] = useState('');
  const [jiraBaseUrl, setJiraBaseUrl] = useState('');
  const [jiraEmail, setJiraEmail] = useState('');
  const [agentExecutionMode, setAgentExecutionMode] = useState('safe');

  const [clearGithubToken, setClearGithubToken] = useState(false);
  const [clearJiraToken, setClearJiraToken] = useState(false);
  const [clearFigmaToken, setClearFigmaToken] = useState(false);
  const [clearOpenAiRuntimeApiKey, setClearOpenAiRuntimeApiKey] = useState(false);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  const [importStatus, setImportStatus] = useState<ImportStatus>('idle');
  const [importMsg, setImportMsg] = useState('');
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const loadSettings = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const response = await fetch('/api/settings', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
      const data = await response.json() as SettingsData;
      setGithubTokenMasked(data.githubTokenMasked ?? false);
      setJiraTokenMasked(data.jiraTokenMasked ?? false);
      setFigmaTokenMasked(data.figmaTokenMasked ?? false);
      setOpenAiRuntimeApiKeyMasked(data.openAiRuntimeApiKeyMasked ?? false);
      setOpenAiTunnelId(data.openAiTunnelId ?? '');
      setJiraBaseUrl(data.jiraBaseUrl ?? '');
      setJiraEmail(data.jiraEmail ?? '');
      setAgentExecutionMode(data.agentExecutionMode || 'safe');
    } catch (error: any) {
      setLoadError(error?.message || 'Settings could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

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
    setErrorMsg('');

    try {
      const payload: Record<string, unknown> = { openAiTunnelId, jiraBaseUrl, jiraEmail, agentExecutionMode };
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

      if (showOpenAiRuntimeApiKey && openAiRuntimeApiKey.trim() !== '') {
        payload.openAiRuntimeApiKey = openAiRuntimeApiKey;
      } else if (clearOpenAiRuntimeApiKey) {
        payload.openAiRuntimeApiKey = '';
        payload.clearOpenAiRuntimeApiKey = true;
      }

      const response = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
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
      applySavedTokenState({
        token: openAiRuntimeApiKey,
        showToken: showOpenAiRuntimeApiKey,
        clearToken: clearOpenAiRuntimeApiKey,
        setToken: setOpenAiRuntimeApiKey,
        setMasked: setOpenAiRuntimeApiKeyMasked,
        setShowToken: setShowOpenAiRuntimeApiKey,
        setClearToken: setClearOpenAiRuntimeApiKey,
      });
      window.setTimeout(() => setSaveStatus('idle'), 3000);
    } catch (error: any) {
      setErrorMsg(error?.message || 'Failed to save settings');
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
      if (!response.ok) throw new Error(data.error ?? 'Import failed');

      setImportStatus('success');
      const countsStr = data.counts ? ` (Projects: ${data.counts.projects || 0}, Tasks: ${data.counts.tasks || 0})` : '';
      setImportMsg(`Import completed${countsStr}. Please restart DevFlow.`);
    } catch (error: any) {
      setImportStatus('error');
      setImportMsg(error?.message || 'Failed to import backup');
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const sharedIntegrationProps = {
    openAiRuntimeApiKey: {
      value: openAiRuntimeApiKey,
      masked: openAiRuntimeApiKeyMasked,
      show: showOpenAiRuntimeApiKey,
      clear: clearOpenAiRuntimeApiKey,
      onValueChange: setOpenAiRuntimeApiKey,
      onShowChange: setShowOpenAiRuntimeApiKey,
      onClearChange: setClearOpenAiRuntimeApiKey,
    },
    openAiTunnelId,
    onOpenAiTunnelIdChange: setOpenAiTunnelId,
    githubToken: {
      value: githubToken,
      masked: githubTokenMasked,
      show: showGithubToken,
      clear: clearGithubToken,
      onValueChange: setGithubToken,
      onShowChange: setShowGithubToken,
      onClearChange: setClearGithubToken,
    },
    jiraToken: {
      value: jiraToken,
      masked: jiraTokenMasked,
      show: showJiraToken,
      clear: clearJiraToken,
      onValueChange: setJiraToken,
      onShowChange: setShowJiraToken,
      onClearChange: setClearJiraToken,
    },
    figmaToken: {
      value: figmaToken,
      masked: figmaTokenMasked,
      show: showFigmaToken,
      clear: clearFigmaToken,
      onValueChange: setFigmaToken,
      onShowChange: setShowFigmaToken,
      onClearChange: setClearFigmaToken,
    },
    jiraBaseUrl,
    jiraEmail,
    onJiraBaseUrlChange: setJiraBaseUrl,
    onJiraEmailChange: setJiraEmail,
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[var(--df-color-backdrop)] p-3 backdrop-blur-sm sm:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-modal-title"
        className="flex max-h-[92vh] w-full max-w-4xl min-w-0 flex-col overflow-hidden rounded-[var(--df-radius-lg)] border border-[var(--df-color-border)] bg-[var(--df-color-surface)] shadow-[var(--df-shadow-lg)]"
      >
        <header className="flex min-w-0 shrink-0 items-center justify-between gap-3 border-b border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <Settings2 size={18} className="shrink-0 text-[var(--df-color-accent)]" />
            <div className="min-w-0">
              <h2 id="settings-modal-title" className="truncate text-base font-extrabold text-[var(--df-color-text-strong)]">Settings</h2>
              <p className="mt-0.5 truncate text-[9.5px] text-[var(--df-color-text-muted)]">Configure DevFlow without exposing stored secrets.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-md p-2 text-[var(--df-color-text-muted)] transition-colors hover:bg-[var(--df-color-surface-muted)] hover:text-[var(--df-color-text-strong)]"
            aria-label="Close Settings"
            title="Close Settings"
          >
            <X size={18} />
          </button>
        </header>

        {loading ? (
          <div className="flex min-h-[320px] flex-1 items-center justify-center gap-2 p-12 text-xs font-bold text-[var(--df-color-text-muted)]" role="status">
            <Loader2 size={20} className="animate-spin text-[var(--df-color-accent)]" /> Loading settings…
          </div>
        ) : loadError ? (
          <div className="flex min-h-[320px] flex-1 items-center justify-center p-6">
            <div className="max-w-lg rounded-[var(--df-radius-lg)] border border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)] p-5">
              <div className="flex items-start gap-2 text-sm font-extrabold text-[var(--df-color-danger)]">
                <AlertCircle size={17} className="mt-0.5 shrink-0" /> Settings could not be loaded
              </div>
              <p className="mt-2 break-words text-[10px] leading-relaxed text-[var(--df-color-text)]">{loadError}</p>
              <button type="button" onClick={() => void loadSettings()} className="df-button df-button--secondary mt-4">Retry</button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex min-h-0 min-w-0 flex-1 flex-col md:flex-row">
              <nav className="shrink-0 border-b border-[var(--df-color-border)] bg-[var(--df-color-surface-subtle)] p-2 md:w-48 md:border-b-0 md:border-r" aria-label="Settings sections">
                <div className="grid grid-cols-2 gap-1 md:grid-cols-1">
                  {SETTINGS_SECTIONS.map(section => {
                    const Icon = section.icon;
                    const selected = activeSection === section.id;
                    return (
                      <button
                        key={section.id}
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        aria-current={selected ? 'page' : undefined}
                        className={`flex min-w-0 items-start gap-2 rounded-[var(--df-radius-sm)] border px-2.5 py-2 text-left transition-colors ${
                          selected
                            ? 'border-[var(--df-color-border-strong)] bg-[var(--df-color-surface-raised)] text-[var(--df-color-text-strong)] shadow-[var(--df-shadow-sm)]'
                            : 'border-transparent text-[var(--df-color-text-muted)] hover:bg-[var(--df-color-surface-muted)] hover:text-[var(--df-color-text-strong)]'
                        }`}
                      >
                        <Icon size={14} className={`mt-0.5 shrink-0 ${selected ? 'text-[var(--df-color-accent)]' : ''}`} />
                        <span className="min-w-0">
                          <span className="block truncate text-[10.5px] font-extrabold">{section.label}</span>
                          <span className="mt-0.5 hidden truncate text-[8.5px] text-[var(--df-color-text-subtle)] md:block">{section.description}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </nav>

              <main className="min-w-0 flex-1 overflow-y-auto p-3 sm:p-4">
                {activeSection === 'runtime' && <IntegrationsSettingsSection section="runtime" {...sharedIntegrationProps} />}
                {activeSection === 'integrations' && <IntegrationsSettingsSection section="integrations" {...sharedIntegrationProps} />}
                {activeSection === 'agents' && (
                  <AgentExecutionModeSection
                    agentExecutionMode={agentExecutionMode}
                    onAgentExecutionModeChange={setAgentExecutionMode}
                  />
                )}
                {activeSection === 'backup' && (
                  <BackupSettingsSection
                    fileInputRef={fileInputRef}
                    importStatus={importStatus}
                    importMsg={importMsg}
                    onImportFile={handleImportFile}
                  />
                )}
              </main>
            </div>

            <footer className="flex min-w-0 shrink-0 flex-col gap-2 border-t border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
              <div className="min-w-0 flex-1" aria-live="polite">
                {saveStatus === 'success' && (
                  <div className="flex min-w-0 items-start gap-1.5 text-[10px] text-[var(--df-color-success)]" role="status">
                    <CheckCircle2 size={13} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 break-words">Settings saved. Runtime connectivity changes apply on the next tunnel start or reconnect.</span>
                  </div>
                )}
                {saveStatus === 'error' && (
                  <div className="flex min-w-0 items-start gap-1.5 text-[10px] text-[var(--df-color-danger)]" role="alert">
                    <AlertCircle size={13} className="mt-0.5 shrink-0" />
                    <span className="min-w-0 break-words">Save failed: {errorMsg}</span>
                  </div>
                )}
                {saveStatus === 'idle' && (
                  <p className="text-[9.5px] leading-relaxed text-[var(--df-color-text-subtle)]">Changes in Runtime, Integrations, and Agent execution are applied together with Save Settings.</p>
                )}
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="df-button df-button--primary shrink-0 sm:min-w-[150px]"
              >
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {saving ? 'Saving…' : 'Save Settings'}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
