export type ServerEventType =
  | 'task.changed'
  | 'job.changed'
  | 'ui-preview.changed'
  | 'atlas.changed'
  | 'project.changed'
  | 'health.regression'
  | 'cache.invalidated'
  | 'settings.changed'
  | 'stream.ready'
  | 'stream.reset';

export type ServerEventPacket = {
  v: 1;
  id?: string;
  type: ServerEventType;
  at: string;
  projectId?: string;
  entityId?: string;
  status?: string;
  reason?: string;
};

type EventSourceLike = {
  addEventListener(type: string, listener: (event: any) => void): void;
  close(): void;
  onopen: ((event: any) => any) | null;
  onerror: ((event: any) => any) | null;
};

type SubscribeOptions = {
  url?: string;
  eventSourceFactory?: (url: string) => EventSourceLike;
  setTimeoutFn?: (callback: () => void, delay: number) => any;
  clearTimeoutFn?: (handle: any) => void;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  onAvailable?: () => void;
  onUnavailable?: () => void;
};

const EVENT_TYPES: ServerEventType[] = [
  'task.changed',
  'job.changed',
  'ui-preview.changed',
  'atlas.changed',
  'project.changed',
  'health.regression',
  'cache.invalidated',
  'settings.changed',
  'stream.ready',
  'stream.reset',
];

function parsePacket(raw: string): ServerEventPacket | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.v !== 1 || typeof parsed.type !== 'string' || typeof parsed.at !== 'string') return null;
    return parsed as ServerEventPacket;
  } catch {
    return null;
  }
}

export function subscribeServerEvents(
  listener: (event: ServerEventPacket) => void,
  options: SubscribeOptions = {},
) {
  const url = options.url || '/api/events';
  const factory = options.eventSourceFactory || ((nextUrl: string) => new EventSource(nextUrl));
  const schedule = options.setTimeoutFn || ((callback, delay) => window.setTimeout(callback, delay));
  const clearSchedule = options.clearTimeoutFn || ((handle) => window.clearTimeout(handle));
  const initialBackoffMs = Math.max(250, options.initialBackoffMs ?? 1_000);
  const maxBackoffMs = Math.max(initialBackoffMs, options.maxBackoffMs ?? 30_000);

  let source: EventSourceLike | null = null;
  let reconnectTimer: any = null;
  let disposed = false;
  let backoffMs = initialBackoffMs;
  let lastEventId = '';

  const connect = () => {
    if (disposed) return;
    const nextUrl = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (lastEventId) nextUrl.searchParams.set('lastEventId', lastEventId);
    source = factory(nextUrl.pathname + nextUrl.search);

    const handle = (nativeEvent: any) => {
      const packet = parsePacket(String(nativeEvent?.data || ''));
      if (!packet) return;
      const nativeId = String(nativeEvent?.lastEventId || packet.id || '').trim();
      if (nativeId) lastEventId = nativeId;
      if (packet.type === 'stream.reset') lastEventId = '';
      listener(packet);
    };
    for (const type of EVENT_TYPES) source.addEventListener(type, handle);

    source.onopen = () => {
      backoffMs = initialBackoffMs;
      options.onAvailable?.();
    };
    source.onerror = () => {
      if (disposed) return;
      source?.close();
      source = null;
      options.onUnavailable?.();
      if (reconnectTimer !== null) clearSchedule(reconnectTimer);
      const delay = backoffMs;
      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);
      reconnectTimer = schedule(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };
  };

  connect();
  return () => {
    if (disposed) return;
    disposed = true;
    if (reconnectTimer !== null) clearSchedule(reconnectTimer);
    reconnectTimer = null;
    source?.close();
    source = null;
  };
}

type ReactiveRefreshOptions = {
  refresh: () => void | Promise<void>;
  eventTypes: ServerEventType[];
  projectId?: string | null;
  fallbackMs?: number;
  subscribe?: typeof subscribeServerEvents;
  setIntervalFn?: (callback: () => void, delay: number) => any;
  clearIntervalFn?: (handle: any) => void;
};

export function startReactiveServerRefresh(options: ReactiveRefreshOptions) {
  const allowed = new Set(options.eventTypes);
  const subscribe = options.subscribe || subscribeServerEvents;
  const setEvery = options.setIntervalFn || ((callback, delay) => window.setInterval(callback, delay));
  const clearEvery = options.clearIntervalFn || ((handle) => window.clearInterval(handle));
  const fallbackMs = Math.max(10_000, options.fallbackMs ?? 60_000);
  const refresh = () => { void options.refresh(); };
  let fallbackTimer: any = null;

  const stopFallback = () => {
    if (fallbackTimer === null) return;
    clearEvery(fallbackTimer);
    fallbackTimer = null;
  };
  const startFallback = () => {
    if (fallbackTimer !== null) return;
    fallbackTimer = setEvery(refresh, fallbackMs);
  };

  refresh();
  startFallback();
  const unsubscribe = subscribe((event) => {
    if (!allowed.has(event.type)) return;
    if (options.projectId && event.projectId && options.projectId !== event.projectId) return;
    refresh();
  }, {
    onAvailable: stopFallback,
    onUnavailable: startFallback,
  });

  return () => {
    unsubscribe();
    stopFallback();
  };
}
