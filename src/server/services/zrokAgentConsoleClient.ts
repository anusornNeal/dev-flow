const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS = Array.from({ length: 101 }, (_, index) => 8888 + index);
const REQUEST_TIMEOUT_MS = 250;
const DISCOVERY_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 256 * 1024;

export interface ZrokLocalAgentShare {
  shareMode: string;
  backendMode: string;
  backendEndpoint: string;
  frontendEndpoint: string;
  status: string;
}

export interface ZrokLocalAgentStatus {
  reachable: boolean;
  shares: ZrokLocalAgentShare[];
}

export interface ZrokAgentConsoleClient {
  getStatus(): Promise<ZrokLocalAgentStatus>;
}

export interface CreateZrokAgentConsoleClientOptions {
  host?: string;
  ports?: number[];
  fetchImpl?: typeof fetch;
}

function validateHost(value: string | undefined): string {
  const host = String(value || DEFAULT_HOST).trim().toLowerCase();
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return host;
  throw new Error('zrok agent console host must be a loopback address.');
}

function validatePorts(value: number[] | undefined): number[] {
  const ports = value ? [...value] : DEFAULT_PORTS;
  if (ports.length > 101 || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error('zrok agent console ports must contain at most 101 valid TCP ports.');
  }
  return ports;
}

function urlFor(host: string, port: number): URL {
  const hostname = host === '::1' ? '[::1]' : host;
  return new URL(`http://${hostname}:${port}/v1/agent/status`);
}

function stringField(record: Record<string, unknown>, name: keyof ZrokLocalAgentShare): string | null {
  const value = record[name];
  return typeof value === 'string' && value.trim() ? value : null;
}

function sanitizeShare(value: unknown): ZrokLocalAgentShare | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const shareMode = stringField(record, 'shareMode');
  const backendMode = stringField(record, 'backendMode');
  const backendEndpoint = stringField(record, 'backendEndpoint');
  const frontendEndpoint = stringField(record, 'frontendEndpoint');
  const status = stringField(record, 'status');
  if (!shareMode || !backendMode || !backendEndpoint || !frontendEndpoint || !status) return null;
  return { shareMode, backendMode, backendEndpoint, frontendEndpoint, status };
}

function parseStatus(payload: string): ZrokLocalAgentStatus | null {
  if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const shares = (parsed as Record<string, unknown>).shares;
  if (shares !== undefined && !Array.isArray(shares)) return null;
  return {
    reachable: true,
    shares: (shares || []).flatMap((share) => {
      const sanitized = sanitizeShare(share);
      return sanitized ? [sanitized] : [];
    }),
  };
}

function canonicalTarget(value: string): string | null {
  try {
    const url = new URL(value.trim());
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

export function selectTargetShare(
  status: ZrokLocalAgentStatus,
  target: string,
): { kind: 'none' | 'one' | 'ambiguous'; share?: ZrokLocalAgentShare } {
  const canonical = canonicalTarget(target);
  if (!canonical) return { kind: 'none' };
  const matches = status.shares.filter((share) => canonicalTarget(share.backendEndpoint) === canonical);
  if (matches.length === 1) return { kind: 'one', share: matches[0] };
  return { kind: matches.length ? 'ambiguous' : 'none' };
}

export function createZrokAgentConsoleClient(options: CreateZrokAgentConsoleClientOptions = {}): ZrokAgentConsoleClient {
  const host = validateHost(options.host);
  const ports = validatePorts(options.ports);
  const fetchImpl = options.fetchImpl || fetch;

  return {
    async getStatus(): Promise<ZrokLocalAgentStatus> {
      const startedAt = Date.now();
      for (const port of ports) {
        const remainingMs = DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) break;
        try {
          const response = await fetchImpl(urlFor(host, port), {
            method: 'GET',
            headers: { accept: 'application/json' },
            signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, remainingMs)),
          });
          if (response.status !== 200) continue;
          const contentLength = Number(response.headers.get('content-length'));
          if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) continue;
          const status = parseStatus(await response.text());
          if (status) return status;
        } catch {
          // A local port can legitimately be closed while the agent starts.
        }
      }
      return { reachable: false, shares: [] };
    },
  };
}
