import { Link } from 'lucide-react';

interface NgrokSettingsSectionProps {
  ngrokUrl: string;
  onNgrokUrlChange: (value: string) => void;
}

export default function NgrokSettingsSection({ ngrokUrl, onNgrokUrlChange }: NgrokSettingsSectionProps) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-1.5 text-sm font-extrabold text-[#534135] dark:text-[#f3eadf]">
        <Link size={14} className="text-[#d89745] dark:text-[#e0a070] dark:text-[#d6b56d]" />
        ngrok URL
      </label>
      <p className="text-[11px] text-[#8a725f] dark:text-[#f3eadf] font-mono -mt-1">
        The public ngrok tunnel URL used by agents to reach this DevFlow instance remotely.
      </p>
      <input
        type="url"
        value={ngrokUrl}
        onChange={event => onNgrokUrlChange(event.target.value)}
        placeholder="https://xxxx.ngrok-free.app"
        className="w-full px-4 py-2.5 text-sm font-mono rounded-xl border border-[#ddd0ba] dark:border-[#584a3b] bg-white dark:bg-[#1e1914] text-[#3e3129] dark:text-[#f3eadf] focus:outline-none focus:ring-2 focus:ring-[#d89745]/50 dark:focus:ring-[#e0a070]/50 focus:border-[#d89745] dark:border-[#e0a070] dark:focus:border-[#e0a070] transition"
      />
    </div>
  );
}
