interface AtlasRefreshStatusProps {
  stale?: boolean;
  status?: {
    shouldRefresh?: boolean;
    reason?: string;
    freshness?: {
      status?: string;
      lastError?: string;
      lastDailyOpenCheckedAt?: string;
    };
  } | null;
  scanState?: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed';
  message?: string;
}

export function AtlasRefreshStatus({ stale, status, scanState = 'idle', message }: AtlasRefreshStatusProps) {
  const label = scanState !== 'idle'
    ? scanState
    : message
      ? 'failed'
      : stale
        ? 'stale'
        : status?.freshness?.status ?? 'unknown';
  const detail = message || status?.reason || status?.freshness?.lastError || status?.freshness?.lastDailyOpenCheckedAt || '';

  return (
    <span className="h-9 rounded-xl border border-[#e5d4bb] dark:border-[#584a3b] bg-[#fff7eb] dark:bg-[#3a2f26] px-3 py-2 text-[10px] font-mono font-black uppercase text-[#9a5b13] dark:text-[#f3eadf]" title={detail}>
      {label}
    </span>
  );
}
