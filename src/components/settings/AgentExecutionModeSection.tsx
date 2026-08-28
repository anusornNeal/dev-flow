import { Activity, ShieldCheck, ShieldAlert } from 'lucide-react';

interface AgentExecutionModeSectionProps {
  agentExecutionMode: string;
  onAgentExecutionModeChange: (value: string) => void;
}

export default function AgentExecutionModeSection({
  agentExecutionMode,
  onAgentExecutionModeChange,
}: AgentExecutionModeSectionProps) {
  return (
    <section className="df-surface min-w-0 p-4" aria-labelledby="settings-agent-execution-title">
      <div className="flex min-w-0 items-start gap-2">
        <Activity size={16} className="mt-0.5 shrink-0 text-[var(--df-color-accent)]" />
        <div className="min-w-0">
          <h3 id="settings-agent-execution-title" className="text-sm font-extrabold text-[var(--df-color-text-strong)]">Agent execution</h3>
          <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
            Choose the permission boundary used when DevFlow auto-triggers agent runs. This setting is saved with the rest of Settings.
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-2">
        <label className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-[var(--df-radius-md)] border p-3 transition-colors ${
          agentExecutionMode === 'safe'
            ? 'border-[var(--df-color-success)] bg-[var(--df-color-success-surface)]'
            : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] hover:border-[var(--df-color-border-strong)]'
        }`}>
          <input
            type="radio"
            name="executionMode"
            value="safe"
            checked={agentExecutionMode === 'safe'}
            onChange={() => onAgentExecutionModeChange('safe')}
            className="mt-1 shrink-0"
          />
          <ShieldCheck size={16} className="mt-0.5 shrink-0 text-[var(--df-color-success)]" />
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold text-[var(--df-color-text-strong)]">Safe Mode · recommended</div>
            <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
              Restricts agents to the managed workspace and blocks arbitrary system commands outside the safer execution boundary.
            </p>
          </div>
        </label>

        <label className={`flex min-w-0 cursor-pointer items-start gap-3 rounded-[var(--df-radius-md)] border p-3 transition-colors ${
          agentExecutionMode === 'full'
            ? 'border-[var(--df-color-danger)] bg-[var(--df-color-danger-surface)]'
            : 'border-[var(--df-color-border)] bg-[var(--df-color-surface-raised)] hover:border-[var(--df-color-border-strong)]'
        }`}>
          <input
            type="radio"
            name="executionMode"
            value="full"
            checked={agentExecutionMode === 'full'}
            onChange={() => onAgentExecutionModeChange('full')}
            className="mt-1 shrink-0"
          />
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-[var(--df-color-danger)]" />
          <div className="min-w-0">
            <div className="text-[12px] font-extrabold text-[var(--df-color-text-strong)]">Full Mode · broader permissions</div>
            <p className="mt-0.5 break-words text-[10px] leading-relaxed text-[var(--df-color-text-muted)]">
              Allows broader execution. Depending on the agent configuration, system commands may run with fewer restrictions.
            </p>
          </div>
        </label>
      </div>
    </section>
  );
}
