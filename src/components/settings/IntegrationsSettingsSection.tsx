import { Cable, FileText, Network } from 'lucide-react';
import TokenCredentialField from './TokenCredentialField';

interface TokenFieldState {
  value: string;
  masked: boolean;
  show: boolean;
  clear: boolean;
  onValueChange: (value: string) => void;
  onShowChange: (value: boolean) => void;
  onClearChange: (value: boolean) => void;
}

interface IntegrationsSettingsSectionProps {
  section: 'runtime' | 'integrations';
  githubToken: TokenFieldState;
  jiraToken: TokenFieldState;
  figmaToken: TokenFieldState;
  openAiRuntimeApiKey: TokenFieldState;
  openAiTunnelId: string;
  jiraBaseUrl: string;
  jiraEmail: string;
  onJiraBaseUrlChange: (value: string) => void;
  onJiraEmailChange: (value: string) => void;
  onOpenAiTunnelIdChange: (value: string) => void;
}

const inputClassName = 'df-control min-w-0 w-full font-mono text-sm';

export default function IntegrationsSettingsSection({
  section,
  githubToken,
  jiraToken,
  figmaToken,
  openAiRuntimeApiKey,
  openAiTunnelId,
  jiraBaseUrl,
  jiraEmail,
  onJiraBaseUrlChange,
  onJiraEmailChange,
  onOpenAiTunnelIdChange,
}: IntegrationsSettingsSectionProps) {
  if (section === 'runtime') {
    return (
      <section className="df-surface min-w-0 p-4" aria-labelledby="settings-runtime-title">
        <div className="flex min-w-0 items-start gap-2">
          <Network size={16} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
          <div className="min-w-0">
            <h3 id="settings-runtime-title" className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Runtime connectivity</h3>
            <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
              Configure the OpenAI tunnel identity and the runtime API key used when DevFlow starts or reconnects this machine.
            </p>
          </div>
        </div>

        <div className="mt-4 grid min-w-0 gap-3">
          <div className="min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
            <label htmlFor="openAiTunnelId" className="text-xs font-extrabold text-[var(--df-color-text-strong)]">OpenAI Tunnel ID</label>
            <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
              Identifies the tunnel used by Start DevFlow. Long IDs stay contained inside this field.
            </p>
            <input
              id="openAiTunnelId"
              type="text"
              value={openAiTunnelId}
              onChange={event => onOpenAiTunnelIdChange(event.target.value)}
              placeholder="tunnel_..."
              spellCheck={false}
              autoComplete="off"
              className={`${inputClassName} mt-2`}
            />
          </div>

          <TokenCredentialField
            label="Runtime API Key"
            description="Stored in the secure credential vault. The saved value is never returned to the browser after saving."
            tokenValue={openAiRuntimeApiKey.value}
            tokenMasked={openAiRuntimeApiKey.masked}
            showToken={openAiRuntimeApiKey.show}
            clearToken={openAiRuntimeApiKey.clear}
            placeholder="Runtime API key..."
            inputName="openAiRuntimeApiKey_devflow_prevent_autofill"
            onTokenChange={openAiRuntimeApiKey.onValueChange}
            onShowTokenChange={openAiRuntimeApiKey.onShowChange}
            onClearTokenChange={openAiRuntimeApiKey.onClearChange}
          />
        </div>

        <div className="mt-3 rounded-[var(--df-radius-sm)] border border-[var(--df-color-info)] bg-[var(--df-color-info-surface)] px-3 py-2 text-[9.5px] leading-relaxed text-[var(--df-color-text)]">
          Saved connectivity changes take effect on the next tunnel start or reconnect.
        </div>
      </section>
    );
  }

  return (
    <section className="df-surface min-w-0 p-4" aria-labelledby="settings-integrations-title">
      <div className="flex min-w-0 items-start gap-2">
        <Cable size={16} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
        <div className="min-w-0">
          <h3 id="settings-integrations-title" className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Integrations & credentials</h3>
          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
            Configure external services independently. Stored secrets remain masked until you replace or clear them.
          </p>
        </div>
      </div>

      <div className="mt-4 grid min-w-0 gap-3">
        <TokenCredentialField
          label="GitHub Access Token"
          description="Securely stored for GitHub API integrations and excluded from logs."
          tokenValue={githubToken.value}
          tokenMasked={githubToken.masked}
          showToken={githubToken.show}
          clearToken={githubToken.clear}
          placeholder="ghp_..."
          inputName="githubToken_devflow_prevent_autofill"
          onTokenChange={githubToken.onValueChange}
          onShowTokenChange={githubToken.onShowChange}
          onClearTokenChange={githubToken.onClearChange}
        />

        <div className="min-w-0 rounded-[var(--df-radius-md)] border border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] p-3">
          <div className="flex min-w-0 items-start gap-2">
            <FileText size={14} className="mt-0.5 shrink-0 text-[var(--df-color-text-muted)]" />
            <div className="min-w-0">
              <h4 className="text-xs font-extrabold text-[var(--df-color-text-strong)]">Jira</h4>
              <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
                Base URL, account email, and API token are saved together through the main Settings save flow.
              </p>
            </div>
          </div>

          <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor="jiraBaseUrl" className="text-[10px] font-extrabold text-[var(--df-color-text-muted)]">Base URL</label>
              <input
                id="jiraBaseUrl"
                type="url"
                value={jiraBaseUrl}
                onChange={event => onJiraBaseUrlChange(event.target.value)}
                placeholder="https://your-domain.atlassian.net"
                className={`${inputClassName} mt-1.5`}
              />
            </div>
            <div className="min-w-0 sm:col-span-2">
              <label htmlFor="jiraEmail" className="text-[10px] font-extrabold text-[var(--df-color-text-muted)]">Email</label>
              <input
                id="jiraEmail"
                type="email"
                value={jiraEmail}
                onChange={event => onJiraEmailChange(event.target.value)}
                placeholder="name@company.com"
                className={`${inputClassName} mt-1.5`}
              />
            </div>
          </div>

          <div className="mt-3">
            <TokenCredentialField
              label="Jira Access Token"
              tokenValue={jiraToken.value}
              tokenMasked={jiraToken.masked}
              showToken={jiraToken.show}
              clearToken={jiraToken.clear}
              placeholder="Jira token..."
              inputName="jiraToken_devflow_prevent_autofill"
              onTokenChange={jiraToken.onValueChange}
              onShowTokenChange={jiraToken.onShowChange}
              onClearTokenChange={jiraToken.onClearChange}
            />
          </div>
        </div>

        <TokenCredentialField
          label="Figma Access Token"
          description="Securely stored for fetching design context from Figma and excluded from logs."
          tokenValue={figmaToken.value}
          tokenMasked={figmaToken.masked}
          showToken={figmaToken.show}
          clearToken={figmaToken.clear}
          placeholder="figd_..."
          inputName="figmaToken_devflow_prevent_autofill"
          onTokenChange={figmaToken.onValueChange}
          onShowTokenChange={figmaToken.onShowChange}
          onClearTokenChange={figmaToken.onClearChange}
        />
      </div>
    </section>
  );
}
