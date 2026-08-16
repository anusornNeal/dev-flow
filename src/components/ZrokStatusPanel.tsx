import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleOff,
  Copy,
  Loader2,
  MonitorUp,
  RefreshCw,
  Server,
  ShieldAlert,
  Wifi,
  WifiOff,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type ZrokStatusKind =
  | 'setup-required'
  | 'starting'
  | 'online'
  | 'degraded'
  | 'offline'
  | 'standby'
  | 'setup-error';

export type ZrokRuntimeStatus = {
  status: ZrokStatusKind;
  baseUrl?: string;
  mcpUrl?: string;
  agentService?: string;
  share?: string;
  publicReachability?: string;
  latencyMs?: number;
  lastCheckedAt?: string;
  message?: string;
  actionability?: string;
  remoteOwner?: string;
};

export type ZrokActionState = 'idle' | 'taking-over' | 'verifying' | 'success' | 'error';

type FetchLike = typeof fetch;

type ZrokStatusPanelProps = {
  initialStatus?: ZrokRuntimeStatus;
  initialExpanded?: boolean;
  initialActionState?: ZrokActionState;
  fetchImpl?: FetchLike;
  pollIntervalMs?: number;
};

type StatusPresentation = {
  label: string;
  description: string;
  icon: LucideIcon;
  badgeClass: string;
  iconClass: string;
};

const DEFAULT_STATUS: ZrokRuntimeStatus = {
  status: 'starting',
  message: 'Checking zrok service, share, and public route…',
};

const STATUS_PRESENTATION: Record<ZrokStatusKind, StatusPresentation> = {
  'setup-required': {
    label: 'Setup required',
    description: 'Run the DevFlow launcher again to finish zrok setup.',
    icon: Wrench,
    badgeClass: 'border-[#e7b77a] bg-[#fff8ec] text-[#955b18] dark:border-[#745736] dark:bg-[#2e251b] dark:text-[#f0c990]',
    iconClass: 'text-[#bd7622] dark:text-[#e4ad69]',
  },
  starting: {
    label: 'Starting',
    description: 'Checking the local agent, named share, and public route.',
    icon: Loader2,
    badgeClass: 'border-[#d8c9b5] bg-[#fdfbf6] text-[#725e4f] dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#e5d8c9]',
    iconClass: 'text-[#a87842] dark:text-[#d6b56d]',
  },
  online: {
    label: 'Online',
    description: 'The managed zrok public route is verified and reachable.',
    icon: CheckCircle2,
    badgeClass: 'border-[#b9d2ae] bg-[#f3f9ef] text-[#4f7545] dark:border-[#52664a] dark:bg-[#233021] dark:text-[#b8d6ae]',
    iconClass: 'text-[#659e51] dark:text-[#9fc493]',
  },
  degraded: {
    label: 'Degraded',
    description: 'zrok is partially available, but public health is not fully healthy.',
    icon: AlertTriangle,
    badgeClass: 'border-[#e7c58d] bg-[#fff9ed] text-[#93611e] dark:border-[#745d39] dark:bg-[#302719] dark:text-[#e9c785]',
    iconClass: 'text-[#c4872d] dark:text-[#d9ad62]',
  },
  offline: {
    label: 'Offline',
    description: 'The managed zrok public route is currently unavailable.',
    icon: WifiOff,
    badgeClass: 'border-[#e5b5aa] bg-[#fff4f1] text-[#a14f43] dark:border-[#72483f] dark:bg-[#30201d] dark:text-[#e7aaa0]',
    iconClass: 'text-[#c25d4e] dark:text-[#df8f83]',
  },
  standby: {
    label: 'Standby',
    description: 'The managed zrok name is active on another machine. Nothing is taken over automatically.',
    icon: MonitorUp,
    badgeClass: 'border-[#b9c9d9] bg-[#f2f7fb] text-[#4f6d86] dark:border-[#495f70] dark:bg-[#202a31] dark:text-[#b8cedf]',
    iconClass: 'text-[#6484a0] dark:text-[#9ebbd1]',
  },
  'setup-error': {
    label: 'Setup error',
    description: 'The local zrok setup needs attention before remote access can start.',
    icon: ShieldAlert,
    badgeClass: 'border-[#e5b5aa] bg-[#fff4f1] text-[#a14f43] dark:border-[#72483f] dark:bg-[#30201d] dark:text-[#e7aaa0]',
    iconClass: 'text-[#c25d4e] dark:text-[#df8f83]',
  },
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedStatus(value: unknown) {
  if (typeof value === 'string') return value.trim() || undefined;
  const record = asRecord(value);
  if (!record) return undefined;
  return safeString(record.status) || safeString(record.state) || safeString(record.message) || safeString(record.name);
}

export function normalizeZrokStatusKind(value: unknown): ZrokStatusKind {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');

  if (['setup-required', 'setup', 'not-configured', 'unconfigured'].includes(normalized)) return 'setup-required';
  if (['online', 'healthy', 'ready', 'connected'].includes(normalized)) return 'online';
  if (['degraded', 'warning', 'unhealthy'].includes(normalized)) return 'degraded';
  if (['offline', 'down', 'disconnected', 'unreachable'].includes(normalized)) return 'offline';
  if (['standby', 'remote-owner', 'owned-remotely'].includes(normalized)) return 'standby';
  if (['setup-error', 'error', 'failed', 'setup-failed'].includes(normalized)) return 'setup-error';
  return 'starting';
}

export function normalizeZrokStatus(payload: unknown): ZrokRuntimeStatus {
  const input = asRecord(payload) || {};
  const publicDetail = asRecord(input.publicReachability) || asRecord(input.publicHealth);
  const owner = asRecord(input.remoteOwner) || asRecord(input.owner);
  const baseUrl = safeString(input.baseUrl) || safeString(input.publicUrl);
  const explicitMcpUrl = safeString(input.mcpUrl);
  const latencyCandidate = input.latencyMs ?? publicDetail?.latencyMs;
  const latencyMs = typeof latencyCandidate === 'number' && Number.isFinite(latencyCandidate) && latencyCandidate >= 0
    ? Math.round(latencyCandidate)
    : undefined;

  return {
    status: normalizeZrokStatusKind(input.status ?? input.state),
    ...(baseUrl ? { baseUrl } : {}),
    ...(explicitMcpUrl ? { mcpUrl: explicitMcpUrl } : {}),
    ...(nestedStatus(input.agentService) ? { agentService: nestedStatus(input.agentService) } : {}),
    ...(nestedStatus(input.share) ? { share: nestedStatus(input.share) } : {}),
    ...(nestedStatus(input.publicReachability ?? input.publicHealth) ? { publicReachability: nestedStatus(input.publicReachability ?? input.publicHealth) } : {}),
    ...(latencyMs !== undefined ? { latencyMs } : {}),
    ...(safeString(input.lastCheckedAt ?? input.lastCheckAt ?? publicDetail?.lastCheckedAt) ? {
      lastCheckedAt: safeString(input.lastCheckedAt ?? input.lastCheckAt ?? publicDetail?.lastCheckedAt),
    } : {}),
    ...(safeString(input.message) ? { message: safeString(input.message) } : {}),
    ...(safeString(input.actionability) ? { actionability: safeString(input.actionability) } : {}),
    ...(safeString(owner?.label ?? owner?.machineName ?? owner?.name) ? { remoteOwner: safeString(owner?.label ?? owner?.machineName ?? owner?.name) } : {}),
  };
}

export function resolveMcpUrl(status: Pick<ZrokRuntimeStatus, 'mcpUrl' | 'baseUrl'>) {
  if (status.mcpUrl) return status.mcpUrl;
  if (!status.baseUrl) return '';
  return `${status.baseUrl.replace(/\/+$/, '')}/mcp`;
}

async function readResponsePayload(response: Response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function responseErrorMessage(payload: unknown, fallback: string) {
  const record = asRecord(payload);
  return safeString(record?.error) || safeString(record?.message) || fallback;
}

export async function requestZrokStatus(fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl('/api/zrok/status', { cache: 'no-store' });
  const payload = await readResponsePayload(response);
  if (!response.ok) throw new Error(responseErrorMessage(payload, `zrok status failed (HTTP ${response.status})`));
  return normalizeZrokStatus(payload);
}

export async function requestZrokTakeover(fetchImpl: FetchLike = fetch) {
  const response = await fetchImpl('/api/zrok/takeover', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ explicit: true }),
  });
  const payload = await readResponsePayload(response);
  if (!response.ok) throw new Error(responseErrorMessage(payload, `zrok takeover failed (HTTP ${response.status})`));
  return payload;
}

export function getZrokStatusPresentation(status: ZrokStatusKind) {
  return STATUS_PRESENTATION[status];
}

function DetailRow({ label, value, icon: Icon }: { label: string; value?: string; icon: LucideIcon }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 text-[10px] font-mono">
      <span className="flex items-center gap-1.5 text-[#8a725f] dark:text-[#cdbba7]">
        <Icon size={12} aria-hidden="true" />
        {label}
      </span>
      <span className="max-w-[190px] truncate font-bold text-[#534135] dark:text-[#f3eadf]" title={value || 'Unknown'}>
        {value || 'Unknown'}
      </span>
    </div>
  );
}

function formatCheckedAt(value?: string) {
  if (!value) return 'Not checked yet';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ZrokStatusPanel({
  initialStatus,
  initialExpanded = false,
  initialActionState = 'idle',
  fetchImpl = fetch,
  pollIntervalMs = 15_000,
}: ZrokStatusPanelProps) {
  const [status, setStatus] = useState<ZrokRuntimeStatus>(initialStatus || DEFAULT_STATUS);
  const [expanded, setExpanded] = useState(initialExpanded);
  const [rechecking, setRechecking] = useState(false);
  const [actionState, setActionState] = useState<ZrokActionState>(initialActionState);
  const [actionMessage, setActionMessage] = useState('');
  const [copied, setCopied] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (showBusy = false) => {
    if (showBusy) {
      setRechecking(true);
      setActionState('idle');
      setActionMessage('');
    }
    try {
      const next = await requestZrokStatus(fetchImpl);
      setStatus(next);
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read zrok status.';
      setStatus((current) => ({
        ...current,
        status: current.status === 'setup-required' ? current.status : 'offline',
        message,
      }));
      return null;
    } finally {
      if (showBusy) setRechecking(false);
    }
  }, [fetchImpl]);

  useEffect(() => {
    void refresh(false);
    const timer = window.setInterval(() => void refresh(false), Math.max(5_000, pollIntervalMs));
    return () => window.clearInterval(timer);
  }, [pollIntervalMs, refresh]);

  useEffect(() => {
    if (!expanded) return;
    const handlePointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setExpanded(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [expanded]);

  const presentation = getZrokStatusPresentation(status.status);
  const StatusIcon = presentation.icon;
  const mcpUrl = resolveMcpUrl(status);
  const takeoverBusy = actionState === 'taking-over' || actionState === 'verifying';
  const statusLabel = status.latencyMs !== undefined && status.status === 'online'
    ? `${presentation.label} · ${status.latencyMs} ms`
    : presentation.label;

  const handleCopy = async (event: React.MouseEvent) => {
    event.stopPropagation();
    if (!mcpUrl) return;
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setActionState('error');
      setActionMessage('Could not copy the MCP URL.');
      setExpanded(true);
    }
  };

  const handleTakeover = async () => {
    if (takeoverBusy) return;
    setActionState('taking-over');
    setActionMessage('Requesting explicit takeover…');
    try {
      await requestZrokTakeover(fetchImpl);
      setActionState('verifying');
      setActionMessage('Takeover requested. Verifying the public route…');
      const verified = await requestZrokStatus(fetchImpl);
      setStatus(verified);
      if (verified.status !== 'online') {
        setActionState('error');
        setActionMessage(verified.message || `Takeover finished, but public health is ${getZrokStatusPresentation(verified.status).label.toLowerCase()}.`);
        return;
      }
      setActionState('success');
      setActionMessage('Takeover complete and public routing is verified on this machine.');
    } catch (error) {
      setActionState('error');
      setActionMessage(error instanceof Error ? error.message : 'Takeover failed.');
    }
  };

  return (
    <div className="relative" ref={rootRef}>
      <div className={`flex items-center rounded-lg border shadow-2xs text-[10px] font-mono ${presentation.badgeClass}`}>
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-7 items-center gap-1.5 px-2.5 py-1 font-bold outline-none rounded-l-lg focus-visible:ring-2 focus-visible:ring-[#d89745]/60 cursor-pointer"
          aria-label={`zrok status: ${statusLabel}. Open connection details`}
          aria-expanded={expanded}
          aria-controls="zrok-status-details"
        >
          <StatusIcon
            size={13}
            aria-hidden="true"
            className={`${presentation.iconClass} ${status.status === 'starting' ? 'animate-spin' : ''}`}
          />
          <span className="whitespace-nowrap">{statusLabel}</span>
          <ChevronDown size={11} aria-hidden="true" className={`opacity-60 transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        {mcpUrl && (
          <>
            <span className="h-3 w-px bg-current opacity-20" aria-hidden="true" />
            <button
              type="button"
              onClick={handleCopy}
              className="flex min-h-7 min-w-7 items-center justify-center rounded-r-lg px-1.5 outline-none transition-colors hover:bg-black/5 focus-visible:ring-2 focus-visible:ring-[#d89745]/60 dark:hover:bg-white/5 cursor-pointer"
              aria-label={copied ? 'MCP URL copied' : 'Copy MCP URL'}
              title={mcpUrl}
            >
              {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            </button>
          </>
        )}
      </div>

      {expanded && (
        <div
          id="zrok-status-details"
          role="dialog"
          aria-label="zrok connection details"
          className="absolute right-0 top-full z-[70] mt-2 w-[360px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-[#e5d4bb] bg-[#fffdfa] shadow-xl dark:border-[#584a3b] dark:bg-[#292119]"
        >
          <div className="border-b border-[#eee2d1] px-3.5 py-3 dark:border-[#584a3b]">
            <div className="flex items-start gap-2.5">
              <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${presentation.badgeClass}`}>
                <StatusIcon size={14} aria-hidden="true" className={`${presentation.iconClass} ${status.status === 'starting' ? 'animate-spin' : ''}`} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-extrabold text-[#3c2a1a] dark:text-[#f3eadf]">zrok · {presentation.label}</span>
                  {status.latencyMs !== undefined && (
                    <span className="rounded-md bg-[#f3ecdf] px-1.5 py-0.5 text-[9px] font-mono font-bold text-[#796553] dark:bg-[#1e1914] dark:text-[#ccb9a4]">
                      {status.latencyMs} ms
                    </span>
                  )}
                </div>
                <p className="mt-0.5 text-[10px] leading-4 text-[#816b5a] dark:text-[#d1c0ad]">
                  {status.message || presentation.description}
                </p>
                {status.status === 'standby' && status.remoteOwner && (
                  <p className="mt-1 text-[10px] font-mono font-bold text-[#58758d] dark:text-[#a9c3d7]">Active on {status.remoteOwner}</p>
                )}
              </div>
            </div>
          </div>

          <div className="px-3.5 py-2">
            <DetailRow label="Agent service" value={status.agentService} icon={Server} />
            <DetailRow label="Named share" value={status.share} icon={Wifi} />
            <DetailRow label="Public health" value={status.publicReachability} icon={status.status === 'offline' ? WifiOff : CheckCircle2} />
            <div className="my-1 border-t border-[#eee2d1] dark:border-[#584a3b]" />
            <div className="flex items-start justify-between gap-3 py-1.5 text-[10px] font-mono">
              <span className="flex shrink-0 items-center gap-1.5 text-[#8a725f] dark:text-[#cdbba7]">
                <MonitorUp size={12} aria-hidden="true" />
                MCP URL
              </span>
              <span className="min-w-0 break-all text-right font-bold text-[#534135] dark:text-[#f3eadf]">
                {mcpUrl || 'Unavailable'}
              </span>
            </div>
            <div className="flex items-center justify-between py-1 text-[9px] font-mono text-[#9a8675] dark:text-[#b9a692]">
              <span>Last checked</span>
              <span>{formatCheckedAt(status.lastCheckedAt)}</span>
            </div>
          </div>

          {(actionMessage || status.status === 'setup-required' || status.status === 'setup-error') && (
            <div
              className={`mx-3.5 mb-2 rounded-lg border px-2.5 py-2 text-[10px] font-mono leading-4 ${
                actionState === 'error' || status.status === 'setup-error'
                  ? 'border-[#e5b5aa] bg-[#fff4f1] text-[#9d4c41] dark:border-[#72483f] dark:bg-[#30201d] dark:text-[#e7aaa0]'
                  : 'border-[#e7c58d] bg-[#fff9ed] text-[#8a5e24] dark:border-[#745d39] dark:bg-[#302719] dark:text-[#e9c785]'
              }`}
              role={actionState === 'error' || status.status === 'setup-error' ? 'alert' : 'status'}
              aria-live="polite"
            >
              <div className="flex items-start gap-1.5">
                {actionState === 'success' ? <CheckCircle2 size={12} className="mt-0.5 shrink-0" aria-hidden="true" /> : <AlertCircle size={12} className="mt-0.5 shrink-0" aria-hidden="true" />}
                <span>{actionMessage || status.message || presentation.description}</span>
              </div>
            </div>
          )}

          <div className="flex items-center justify-end gap-2 border-t border-[#eee2d1] bg-[#fdfbf6] px-3.5 py-2.5 dark:border-[#584a3b] dark:bg-[#241d17]">
            <button
              type="button"
              onClick={() => void refresh(true)}
              disabled={rechecking || takeoverBusy}
              className="flex min-h-7 items-center gap-1.5 rounded-lg border border-[#ddd0ba] bg-white px-2.5 py-1 text-[10px] font-bold text-[#725e4f] outline-none transition-colors hover:bg-[#f6efe3] focus-visible:ring-2 focus-visible:ring-[#d89745]/60 disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#584a3b] dark:bg-[#292119] dark:text-[#e8dbcd] dark:hover:bg-[#352a21] cursor-pointer"
              aria-label="Recheck zrok status"
            >
              <RefreshCw size={12} aria-hidden="true" className={rechecking ? 'animate-spin' : ''} />
              {rechecking ? 'Checking…' : 'Recheck'}
            </button>

            {status.status === 'standby' && (
              <button
                type="button"
                onClick={() => void handleTakeover()}
                disabled={takeoverBusy}
                className="flex min-h-7 items-center gap-1.5 rounded-lg bg-[#3c2a1a] px-2.5 py-1 text-[10px] font-extrabold text-white outline-none transition-colors hover:bg-[#2a1d12] focus-visible:ring-2 focus-visible:ring-[#d89745]/70 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#e0a070] dark:text-[#292119] dark:hover:bg-[#cc8e60] cursor-pointer"
                aria-label="Take over zrok connection from the active machine"
                aria-busy={takeoverBusy}
              >
                {takeoverBusy ? <Loader2 size={12} className="animate-spin" aria-hidden="true" /> : <MonitorUp size={12} aria-hidden="true" />}
                {actionState === 'verifying' ? 'Verifying…' : actionState === 'taking-over' ? 'Taking over…' : 'Take over'}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
