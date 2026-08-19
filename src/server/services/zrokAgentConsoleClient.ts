const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORTS = Array.from({ length: 101 }, (_, index) => 8888 + index);
const REQUEST_TIMEOUT_MS = 250;
const DISCOVERY_TIMEOUT_MS = 1_500;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_FRONTEND_ENDPOINT_LENGTH = 2_048;
const MAX_FRONTEND_ENDPOINT_CANDIDATES = 16;

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

function usableFrontendEndpoint(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const endpoint = value.trim();
  if (!endpoint || endpoint.length > MAX_FRONTEND_ENDPOINT_LENGTH || /[\u0000-\u001f\u007f]/.test(endpoint)) return null;
  try {
    const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
    const url = new URL(candidate);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) return null;
    return endpoint;
  } catch {
    return null;
  }
}

function frontendEndpointField(value: unknown): string | null {
  const candidates = Array.isArray(value) ? value : [value];
  if (candidates.length > MAX_FRONTEND_ENDPOINT_CANDIDATES) return null;
  const usable = candidates.flatMap((candidate) => {
    const endpoint = usableFrontendEndpoint(candidate);
    return endpoint ? [endpoint] : [];
  });
  return usable.length === 1 ? usable[0] : null;
}

function sanitizeShare(value: unknown): ZrokLocalAgentShare | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const shareMode = stringField(record, 'shareMode');
  const backendMode = stringField(record, 'backendMode');
  const backendEndpoint = stringField(record, 'backendEndpoint');
  const frontendEndpoint = frontendEndpointField(record.frontendEndpoint);
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
  const rawShares = (parsed as Record<string, unknown>).shares;
  if (rawShares !== undefined && !Array.isArray(rawShares)) return null;
  const shares = Array.isArray(rawShares) ? rawShares : [];
  return {
    reachable: true,
    shares: shares.flatMap((share) => {
      const sanitized = sanitizeShare(share);
      return sanitized ? [sanitized] : [];
    }),
  };
}

async function readResponseText(response: Response): Promise<string | null> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return text + decoder.decode();
      bytesRead += value.byteLength;
      if (bytesRead > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
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
  const matches = status.shares.filter((share) => {
    const shareMode = share.shareMode.trim().toLowerCase();
    const backendMode = share.backendMode.trim().toLowerCase();
    const lifecycle = share.status.trim().toLowerCase();
    return shareMode === 'public'
      && backendMode === 'proxy'
      && (lifecycle === 'active' || lifecycle === 'retrying' || lifecycle === 'failed')
      && canonicalTarget(share.backendEndpoint) === canonical;
  });
  if (matches.length === 1) return { kind: 'one', share: matches[0] };
  return { kind: matches.length ? 'ambiguous' : 'none' };
}

export function createZrokAgentConsoleClient(options: CreateZrokAgentConsoleClientOptions = {}): ZrokAgentConsoleClient {
  const host = validateHost(options.host);
  const ports = validatePorts(options.ports);
  const fetchImpl = options.fetchImpl || fetch;
  let verifiedPort: number | null = null;

  const probePort = async (port: number, timeoutMs: number): Promise<ZrokLocalAgentStatus | null> => {
    try {
      const response = await fetchImpl(urlFor(host, port), {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, timeoutMs))),
      });
      if (response.status !== 200) return null;
      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) return null;
      const body = await readResponseText(response);
      if (body === null) return null;
      return parseStatus(body);
    } catch {
      return null;
    }
  };

  return {
    async getStatus(): Promise<ZrokLocalAgentStatus> {
      const startedAt = Date.now();
      const previouslyVerifiedPort = verifiedPort;

      if (previouslyVerifiedPort !== null) {
        const remainingMs = DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs > 0) {
          const status = await probePort(previouslyVerifiedPort, remainingMs);
          if (status) return status;
        }
        verifiedPort = null;
      }

      for (const port of ports) {
        if (port === previouslyVerifiedPort) continue;
        const remainingMs = DISCOVERY_TIMEOUT_MS - (Date.now() - startedAt);
        if (remainingMs <= 0) break;
        const status = await probePort(port, remainingMs);
        if (status) {
          verifiedPort = port;
          return status;
        }
      }
      return { reachable: false, shares: [] };
    },
  };
}
