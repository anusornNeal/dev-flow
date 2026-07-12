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

export function AtlasRefreshStatus({ stale, status, message }: AtlasRefreshStatusProps) {
  const freshnessStatus = status?.freshness?.status;
  const label = message
    ? 'invalid'
    : freshnessStatus === 'not-generated'
      ? 'missing'
      : stale
        ? 'needs ChatGPT update'
        : freshnessStatus === 'fresh'
          ? 'authored'
          : freshnessStatus ?? 'missing';
  const detail = message || status?.reason || status?.freshness?.lastError || '';

  return (
    <span className="h-8 rounded-lg border border-[#e5d4bb] bg-[#fff7eb] px-2.5 py-1.5 text-[9px] font-mono font-black uppercase text-[#9a5b13] dark:border-[#584a3b] dark:bg-[#3a2f26] dark:text-[#f3eadf]" title={detail}>
      {label}
    </span>
  );
}
