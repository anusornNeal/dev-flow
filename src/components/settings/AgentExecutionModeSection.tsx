import { Activity } from 'lucide-react';

interface AgentExecutionModeSectionProps {
  agentExecutionMode: string;
  onAgentExecutionModeChange: (value: string) => void;
}

export default function AgentExecutionModeSection({
  agentExecutionMode,
  onAgentExecutionModeChange,
}: AgentExecutionModeSectionProps) {
  return (
    <div className="pt-4 mt-2 border-t border-[#ebdcb9] dark:border-[#584a3b] flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135] dark:text-[#f3eadf]">
          <Activity size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
          Agent Execution Mode
        </label>
        <p className="text-[11px] text-[#8a725f] dark:text-[#f3eadf] font-mono leading-relaxed">
          Controls the permissions granted to agents when DevFlow auto-triggers runs.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <label className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${agentExecutionMode === 'safe' ? 'bg-[#f0f9f4] dark:bg-[#1e1914] border-[#a3e6cd] dark:border-[#584a3b] shadow-sm' : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] hover:bg-[#faf7f0] dark:bg-[#1e1914] dark:hover:bg-[#1e1914]'}`}>
          <input type="radio" name="executionMode" value="safe" checked={agentExecutionMode === 'safe'} onChange={() => onAgentExecutionModeChange('safe')} className="mt-1" />
          <div className="flex flex-col">
            <span className={`text-[12px] font-bold ${agentExecutionMode === 'safe' ? 'text-[#166534] dark:text-[#f3eadf]' : 'text-[#534135] dark:text-[#f3eadf]'}`}>Safe Mode (Recommended)</span>
            <span className="text-[10px] text-[#8a725f] dark:text-[#f3eadf] font-mono">Restricts agents to editing files within the workspace. Blocks arbitrary system commands.</span>
          </div>
        </label>
        <label className={`flex items-start gap-2 p-2.5 rounded-lg border cursor-pointer transition-colors ${agentExecutionMode === 'full' ? 'bg-[#fff0f0] dark:bg-[#1e1914] border-[#fecaca] dark:border-[#584a3b] shadow-sm' : 'bg-white dark:bg-[#1e1914] border-[#ebdcb9] dark:border-[#584a3b] hover:bg-[#faf7f0] dark:bg-[#1e1914] dark:hover:bg-[#1e1914]'}`}>
          <input type="radio" name="executionMode" value="full" checked={agentExecutionMode === 'full'} onChange={() => onAgentExecutionModeChange('full')} className="mt-1" />
          <div className="flex flex-col">
            <span className={`text-[12px] font-bold ${agentExecutionMode === 'full' ? 'text-[#991b1b] dark:text-[#f3eadf]' : 'text-[#534135] dark:text-[#f3eadf]'}`}>Full Mode</span>
            <span className="text-[10px] text-[#8a725f] dark:text-[#f3eadf] font-mono">Grants broader permissions. Agents may run arbitrary system commands depending on their config.</span>
          </div>
        </label>
      </div>
    </div>
  );
}
