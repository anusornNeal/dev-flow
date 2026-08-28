import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

const events = await import('../../src/server/services/serverEventService.js') as any;
const { registerEventRoutes } = await import('../../src/server/routes/events.js') as any;

function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const started = Date.now();
  return new Promise<void>((resolve, reject) => {
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for server event condition'));
      }
    }, 10);
  });
}

function eventSequence(id: string) {
  return Number(id.slice(id.lastIndexOf('.') + 1));
}

function eventStreamId(id: string) {
  return id.slice(0, id.lastIndexOf('.'));
}

test.beforeEach(() => events.__resetServerEventsForTests());

test('published events are versioned, ordered, and compact invalidation notices', () => {
  const first = events.publishServerEvent('task.changed', {
    projectId: 'project-1',
    entityId: 'task-1',
    status: 'in-progress',
    reason: 'saved',
  });
  const second = events.publishServerEvent('job.changed', {
    projectId: 'project-1',
    entityId: 'job-1',
    status: 'running',
    reason: 'claimed',
  });
  const execution = events.publishServerEvent('execution.changed', {
    projectId: 'project-1',
    entityId: 'exec-1',
    status: 'implementing',
    reason: 'mutation-applied',
    workspacePath: 'C:\\secret\\workspace',
    rawLog: 'token=do-not-emit',
  } as any);

  assert.equal(first.v, 1);
  assert.equal(first.type, 'task.changed');
  assert.equal(eventStreamId(second.id), eventStreamId(first.id));
  assert.equal(eventSequence(second.id), eventSequence(first.id) + 1);
  assert.equal(eventSequence(execution.id), eventSequence(second.id) + 1);
  assert.equal(execution.type, 'execution.changed');
  assert.deepEqual(Object.keys(execution).sort(), ['at', 'entityId', 'id', 'projectId', 'reason', 'status', 'type', 'v'].sort());
  assert.equal(JSON.stringify(execution).includes('workspacePath'), false);
  assert.equal(JSON.stringify(execution).includes('rawLog'), false);
  assert.equal(JSON.stringify(execution).includes('do-not-emit'), false);
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(first).sort(), ['at', 'entityId', 'id', 'projectId', 'reason', 'status', 'type', 'v'].sort());
  assert.equal(JSON.stringify(first).includes('description'), false);
});

test('replay returns only events newer than Last-Event-ID and reports unavailable history', () => {
  const a = events.publishServerEvent('task.changed', { entityId: 'task-a' });
  const b = events.publishServerEvent('project.changed', { entityId: 'project-b' });
  const c = events.publishServerEvent('settings.changed', { reason: 'saved' });

  const replay = events.getServerEventReplay(b.id);
  assert.equal(replay.resetRequired, false);
  assert.deepEqual(replay.events.map((event: any) => event.id), [c.id]);
  assert.equal(events.getServerEventReplay(a.id).events.length, 2);
  assert.equal(events.getServerEventReplay(`${eventStreamId(c.id)}.999999`).resetRequired, true);
  assert.equal(events.getServerEventReplay(`stale-stream.${eventSequence(c.id)}`).resetRequired, true, 'a prior server generation must force stream.reset');
});

test('subscriber count is bounded and unsubscribe releases capacity', () => {
  const handles: any[] = [];
  for (let index = 0; index < events.SERVER_EVENT_MAX_SUBSCRIBERS; index += 1) {
    handles.push(events.subscribeServerEvents(() => {}));
  }
  assert.equal(events.getServerEventDiagnostics().subscriberCount, events.SERVER_EVENT_MAX_SUBSCRIBERS);
  assert.throws(() => events.subscribeServerEvents(() => {}), /subscriber capacity/i);
  handles[0].unsubscribe();
  assert.equal(events.getServerEventDiagnostics().subscriberCount, events.SERVER_EVENT_MAX_SUBSCRIBERS - 1);
  const replacement = events.subscribeServerEvents(() => {});
  replacement.unsubscribe();
  handles.slice(1).forEach((handle) => handle.unsubscribe());
  assert.equal(events.getServerEventDiagnostics().subscriberCount, 0);
});

test('SSE route emits retry framing, replays events, streams live events, and cleans up on disconnect', async () => {
  const prior = events.publishServerEvent('task.changed', { projectId: 'project-1', entityId: 'task-before' });
  const replayed = events.publishServerEvent('job.changed', { projectId: 'project-1', entityId: 'job-before', status: 'queued' });

  const app = express();
  registerEventRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind test server');

  let body = '';
  const request = http.request({
    hostname: '127.0.0.1',
    port: address.port,
    path: '/api/events',
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'Last-Event-ID': prior.id },
  });
  request.on('response', (response) => {
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers['content-type']), /text\/event-stream/);
    response.setEncoding('utf8');
    response.on('data', (chunk) => { body += chunk; });
  });
  request.end();

  try {
    await waitFor(() => body.includes('retry:') && body.includes(replayed.id));
    assert.equal(events.getServerEventDiagnostics().subscriberCount, 1);

    const live = events.publishServerEvent('health.regression', { status: 'warning', reason: 'synthetic-test' });
    await waitFor(() => body.includes(live.id) && body.includes('health.regression'));

    request.destroy();
    await waitFor(() => events.getServerEventDiagnostics().subscriberCount === 0);
  } finally {
    request.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
