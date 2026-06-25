export type TransportKind = 'rest' | 'mcp' | 'sse' | 'proxy';

export const TRANSPORT_NAMES: ReadonlySet<TransportKind> = new Set(['rest', 'mcp', 'sse', 'proxy']);

export function resolveTransport(path: string): TransportKind | null {
  if (typeof path !== 'string') return null;
  if (path === '/sse' || path.startsWith('/sse/')) return 'sse';
  if (path === '/mcp' || path.startsWith('/mcp/')) return 'mcp';
  if (path === '/api' || path.startsWith('/api/')) return 'rest';
  if (path === '/proxy' || path.startsWith('/proxy/')) return 'proxy';
  if (path === '/github/sse' || path.startsWith('/github/')) return 'proxy';
  return null;
}

export interface TransportDescriptor {
  kind: TransportKind;
  basePath: string;
}

export const TRANSPORTS: ReadonlyArray<TransportDescriptor> = [
  { kind: 'rest', basePath: '/api' },
  { kind: 'mcp', basePath: '/mcp' },
  { kind: 'sse', basePath: '/sse' },
  { kind: 'proxy', basePath: '/proxy' },
];

export function isTransportKind(value: string): value is TransportKind {
  return TRANSPORT_NAMES.has(value as TransportKind);
}
