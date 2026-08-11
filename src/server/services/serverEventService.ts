import { randomUUID } from 'node:crypto';

export const SERVER_EVENT_VERSION = 1 as const;
export const SERVER_EVENT_MAX_SUBSCRIBERS = 64;
export const SERVER_EVENT_REPLAY_LIMIT = 256;

export type ServerDomainEventType =
  | 'task.changed'
  | 'job.changed'
  | 'ui-preview.changed'
  | 'atlas.changed'
  | 'project.changed'
  | 'health.regression'
  | 'cache.invalidated'
  | 'settings.changed';

export type ServerDomainEvent = {
  v: typeof SERVER_EVENT_VERSION;
  id: string;
  type: ServerDomainEventType;
  at: string;
  projectId?: string;
  entityId?: string;
  status?: string;
  reason?: string;
};

export type ServerEventInput = Pick<ServerDomainEvent, 'projectId' | 'entityId' | 'status' | 'reason'>;
export type ServerEventSubscriber = (event: ServerDomainEvent) => void;

type Subscriber = { id: number; listener: ServerEventSubscriber };

const replayBuffer: ServerDomainEvent[] = [];
const subscribers = new Map<number, Subscriber>();
const SERVER_EVENT_STREAM_ID = randomUUID().replace(/-/g, '').slice(0, 12);
let nextEventSequence = 1;
let nextSubscriberId = 1;

function formatEventId(sequence: number) {
  return `${SERVER_EVENT_STREAM_ID}.${sequence}`;
}

function parseEventId(value: string) {
  const separator = value.lastIndexOf('.');
  if (separator <= 0 || separator === value.length - 1) return null;
  const streamId = value.slice(0, separator);
  const sequence = Number(value.slice(separator + 1));
  if (!streamId || !Number.isSafeInteger(sequence) || sequence < 0) return null;
  return { streamId, sequence };
}

function compactString(value: unknown, maxLength: number) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}

function normalizeInput(input: ServerEventInput = {}): ServerEventInput {
  return {
    projectId: compactString(input.projectId, 160),
    entityId: compactString(input.entityId, 180),
    status: compactString(input.status, 80),
    reason: compactString(input.reason, 240),
  };
}

export class ServerEventCapacityError extends Error {
  code = 'SERVER_EVENT_SUBSCRIBER_CAPACITY';
  constructor() {
    super(`Server event subscriber capacity reached (${SERVER_EVENT_MAX_SUBSCRIBERS}).`);
    this.name = 'ServerEventCapacityError';
  }
}

export function publishServerEvent(type: ServerDomainEventType, input: ServerEventInput = {}): ServerDomainEvent {
  const event: ServerDomainEvent = {
    v: SERVER_EVENT_VERSION,
    id: formatEventId(nextEventSequence++),
    type,
    at: new Date().toISOString(),
    ...Object.fromEntries(Object.entries(normalizeInput(input)).filter(([, value]) => value !== undefined)),
  } as ServerDomainEvent;

  replayBuffer.push(event);
  if (replayBuffer.length > SERVER_EVENT_REPLAY_LIMIT) {
    replayBuffer.splice(0, replayBuffer.length - SERVER_EVENT_REPLAY_LIMIT);
  }

  for (const { listener } of subscribers.values()) {
    try {
      listener(event);
    } catch {
      // A broken subscriber must never interrupt domain mutations or other subscribers.
    }
  }
  return event;
}

export function getServerEventReplay(lastEventId?: string) {
  const raw = String(lastEventId || '').trim();
  if (!raw) return { events: [] as ServerDomainEvent[], resetRequired: false };
  const last = parseEventId(raw);
  if (!last || last.streamId !== SERVER_EVENT_STREAM_ID) {
    return { events: [] as ServerDomainEvent[], resetRequired: true };
  }

  const latestSequence = nextEventSequence - 1;
  if (last.sequence > latestSequence) return { events: [] as ServerDomainEvent[], resetRequired: true };
  if (last.sequence === latestSequence) return { events: [] as ServerDomainEvent[], resetRequired: false };
  if (replayBuffer.length === 0) return { events: [] as ServerDomainEvent[], resetRequired: last.sequence !== latestSequence };

  const oldest = parseEventId(replayBuffer[0].id)?.sequence ?? latestSequence;
  if (last.sequence < oldest - 1) return { events: [] as ServerDomainEvent[], resetRequired: true };
  return {
    events: replayBuffer.filter((event) => (parseEventId(event.id)?.sequence ?? 0) > last.sequence),
    resetRequired: false,
  };
}

export function subscribeServerEvents(listener: ServerEventSubscriber) {
  if (subscribers.size >= SERVER_EVENT_MAX_SUBSCRIBERS) throw new ServerEventCapacityError();
  const id = nextSubscriberId++;
  subscribers.set(id, { id, listener });
  let active = true;
  return {
    subscriberId: id,
    unsubscribe() {
      if (!active) return;
      active = false;
      subscribers.delete(id);
    },
  };
}

export function getServerEventDiagnostics() {
  return {
    subscriberCount: subscribers.size,
    subscriberLimit: SERVER_EVENT_MAX_SUBSCRIBERS,
    replayCount: replayBuffer.length,
    replayLimit: SERVER_EVENT_REPLAY_LIMIT,
    latestEventId: formatEventId(nextEventSequence - 1),
  };
}

export function __resetServerEventsForTests() {
  replayBuffer.length = 0;
  subscribers.clear();
  nextEventSequence = 1;
  nextSubscriberId = 1;
}
