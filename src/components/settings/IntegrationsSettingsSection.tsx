import { FileText } from 'lucide-react';
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
  githubToken: TokenFieldState;
  jiraToken: TokenFieldState;
  figmaToken: TokenFieldState;
  jiraBaseUrl: string;
  jiraEmail: string;
  onJiraBaseUrlChange: (value: string) => void;
  onJiraEmailChange: (value: string) => void;
}

export default function IntegrationsSettingsSection({
  githubToken,
  jiraToken,
  figmaToken,
  jiraBaseUrl,
  jiraEmail,
  onJiraBaseUrlChange,
  onJiraEmailChange,
}: IntegrationsSettingsSectionProps) {
  return (
    <div className="flex flex-col gap-5 border border-[#e5d4bb] dark:border-[#584a3b] rounded-xl p-4 bg-[#fdfbf6] dark:bg-[#1e1914]">
      <div>
        <h3 className="text-sm font-extrabold text-[#534135] dark:text-[#f3eadf] flex items-center gap-1.5 mb-1">
          <FileText size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
          Integrations
        </h3>
        <p className="text-[11px] text-[#8a725f] dark:text-[#f3eadf] font-mono">
          Configure external API credentials for GitHub and Jira.
        </p>
      </div>

      <div className="pt-2 border-t border-[#ebdcb9] dark:border-[#584a3b]">
        <TokenCredentialField
          label="GitHub Access Token"
          description="Securely stored token for GitHub API integrations. Not shown in logs."
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
      </div>

      <div className="flex flex-col gap-3 pt-3 border-t border-[#ebdcb9] dark:border-[#584a3b]">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-bold text-[#685547] dark:text-[#f3eadf]">Jira Integration</label>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-[10px] font-bold text-[#8a725f] dark:text-[#f3eadf] uppercase tracking-wider">Base URL</label>
          <input
            type="url"
            value={jiraBaseUrl}
            onChange={event => onJiraBaseUrlChange(event.target.value)}
            placeholder="https://your-domain.atlassian.net"
            className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[#3e3129] dark:text-[#f3eadf] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 dark:focus:ring-[#e0a070]/50 focus:border-[#d89745] dark:border-[#e0a070] dark:focus:border-[#e0a070] transition"
          />
        </div>

        <div className="flex flex-col gap-1.5 mt-1">
          <label className="text-[10px] font-bold text-[#8a725f] dark:text-[#f3eadf] uppercase tracking-wider">Email</label>
          <input
            type="email"
            value={jiraEmail}
            onChange={event => onJiraEmailChange(event.target.value)}
            placeholder="name@company.com"
            className="w-full px-3 py-2 text-sm font-mono rounded-lg border border-[#ddd0ba] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[#3e3129] dark:text-[#f3eadf] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 dark:focus:ring-[#e0a070]/50 focus:border-[#d89745] dark:border-[#e0a070] dark:focus:border-[#e0a070] transition"
          />
        </div>

        <div className="mt-1">
          <TokenCredentialField
            label="Access Token"
            tokenValue={jiraToken.value}
            tokenMasked={jiraToken.masked}
            showToken={jiraToken.show}
            clearToken={jiraToken.clear}
            placeholder="Jira token..."
            inputName="jiraToken_devflow_prevent_autofill"
            labelClassName="text-[10px] font-bold text-[#8a725f] dark:text-[#f3eadf] uppercase tracking-wider"
            onTokenChange={jiraToken.onValueChange}
            onShowTokenChange={jiraToken.onShowChange}
            onClearTokenChange={jiraToken.onClearChange}
          />
        </div>
      </div>

      <div className="pt-3 border-t border-[#ebdcb9] dark:border-[#584a3b]">
        <TokenCredentialField
          label="Figma Access Token"
          description="Securely stored token for fetching design context from Figma. Not shown in logs."
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
    </div>
  );
}
