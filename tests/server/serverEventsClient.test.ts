import test from 'node:test';
import assert from 'node:assert/strict';

const client = await import('../../src/lib/serverEvents.js') as any;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  closed = false;
  listeners = new Map<string, Set<(event: any) => void>>();
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void) {
    const set = this.listeners.get(type) || new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  emit(type: string, packet: any, lastEventId = '') {
    for (const listener of this.listeners.get(type) || []) {
      listener({ data: JSON.stringify(packet), lastEventId });
    }
  }

  close() {
    this.closed = true;
  }
}

test.beforeEach(() => { FakeEventSource.instances = []; });

test('subscription dispatches compact events immediately and cleanup closes the source', () => {
  const received: any[] = [];
  const unsubscribe = client.subscribeServerEvents((event: any) => received.push(event), {
    eventSourceFactory: (url: string) => new FakeEventSource(url),
    setTimeoutFn: () => 1,
    clearTimeoutFn: () => {},
  });

  const source = FakeEventSource.instances[0];
  source.emit('job.changed', { v: 1, id: '7', type: 'job.changed', at: new Date().toISOString(), entityId: 'job-7', status: 'running' }, '7');
  assert.equal(received.length, 1);
  assert.equal(received[0].entityId, 'job-7');
  source.emit('execution.changed', { v: 1, id: '8', type: 'execution.changed', at: new Date().toISOString(), projectId: 'project-1', entityId: 'exec-8', status: 'verifying' }, '8');
  assert.equal(received.length, 2);
  assert.equal(received[1].type, 'execution.changed');
  assert.equal(received[1].entityId, 'exec-8');
  source.emit('ui-preview.changed', { v: 1, id: '9', type: 'ui-preview.changed', at: new Date().toISOString(), entityId: 'uip-9', reason: 'created' }, '9');
  assert.equal(received.length, 3);
  assert.equal(received[2].type, 'ui-preview.changed');
  assert.deepEqual(client.GLOBAL_RUNTIME_INVALIDATION_EVENT_TYPES, ['task.changed', 'job.changed', 'project.changed', 'execution.changed']);

  unsubscribe();
  assert.equal(source.closed, true);
});

test('subscription reconnects with bounded backoff and carries lastEventId in the reconnect URL', () => {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const unsubscribe = client.subscribeServerEvents(() => {}, {
    eventSourceFactory: (url: string) => new FakeEventSource(url),
    setTimeoutFn: (callback: () => void, delay: number) => { timers.push(callback); delays.push(delay); return timers.length; },
    clearTimeoutFn: () => {},
    initialBackoffMs: 500,
    maxBackoffMs: 2000,
  });

  const first = FakeEventSource.instances[0];
  first.emit('task.changed', { v: 1, id: '11', type: 'task.changed', at: new Date().toISOString(), entityId: 'task-1' }, '11');
  first.onerror?.();
  assert.equal(first.closed, true);
  assert.equal(delays[0], 500);
  timers.shift()?.();
  assert.match(FakeEventSource.instances[1].url, /lastEventId=11/);

  FakeEventSource.instances[1].onerror?.();
  assert.equal(delays[1], 1000);
  unsubscribe();
});

test('reactive refresh coalesces burst invalidations while fallback remains bounded', async () => {
  let listener: ((event: any) => void) | null = null;
  let refreshes = 0;
  let fallback: (() => void) | null = null;
  let cleared = false;

  const stop = client.startReactiveServerRefresh({
    refresh: () => { refreshes += 1; },
    eventTypes: ['job.changed', 'health.regression'],
    fallbackMs: 60_000,
    subscribe: (next: (event: any) => void) => { listener = next; return () => { listener = null; }; },
    setIntervalFn: (callback: () => void, delay: number) => { assert.equal(delay, 60_000); fallback = callback; return 9; },
    clearIntervalFn: () => { cleared = true; },
  });

  assert.equal(refreshes, 1, 'initial refresh should happen immediately');
  listener?.({ v: 1, id: '2', type: 'task.changed', at: new Date().toISOString() });
  assert.equal(refreshes, 1, 'irrelevant events must not refresh');
  listener?.({ v: 1, id: '3', type: 'job.changed', at: new Date().toISOString() });
  listener?.({ v: 1, id: '4', type: 'job.changed', at: new Date().toISOString() });
  assert.equal(refreshes, 1, 'burst invalidations are queued instead of refreshing repeatedly in the same turn');
  await Promise.resolve();
  assert.equal(refreshes, 2, 'matching burst coalesces to one event-driven refresh');
  fallback?.();
  assert.equal(refreshes, 3);

  stop();
  assert.equal(listener, null);
  assert.equal(cleared, true);
});

test('reactive refresh fallback runs only while the SSE stream is unavailable', async () => {
  let listener: ((event: any) => void) | null = null;
  let availability: { onAvailable?: () => void; onUnavailable?: () => void } = {};
  const intervalCallbacks: Array<() => void> = [];
  const cleared: number[] = [];
  let refreshes = 0;

  const stop = client.startReactiveServerRefresh({
    refresh: () => { refreshes += 1; },
    eventTypes: ['task.changed'],
    fallbackMs: 60_000,
    subscribe: (next: (event: any) => void, options: any) => {
      listener = next;
      availability = options;
      return () => { listener = null; };
    },
    setIntervalFn: (callback: () => void) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearIntervalFn: (handle: number) => { cleared.push(handle); },
  });

  assert.equal(refreshes, 1, 'initial reconciliation still runs immediately');
  assert.equal(intervalCallbacks.length, 1, 'fallback is armed until SSE becomes available');
  availability.onAvailable?.();
  assert.deepEqual(cleared, [1], 'fallback stops as soon as SSE connects');

  listener?.({ v: 1, type: 'task.changed', at: new Date().toISOString() });
  await Promise.resolve();
  assert.equal(refreshes, 2);
  listener?.({ v: 1, type: 'stream.reset', at: new Date().toISOString() });
  await Promise.resolve();
  assert.equal(refreshes, 3, 'stream reset invalidates state even when it is not explicitly listed');
  availability.onUnavailable?.();
  assert.equal(intervalCallbacks.length, 2, 'fallback restarts only after SSE becomes unavailable');
  intervalCallbacks[1]?.();
  assert.equal(refreshes, 4);
  availability.onAvailable?.();
  assert.deepEqual(cleared, [1, 2], 'reconnect clears the outage fallback again');

  stop();
  assert.equal(listener, null);
});
