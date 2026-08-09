import type express from 'express';
import {
  ServerEventCapacityError,
  getServerEventReplay,
  subscribeServerEvents,
  type ServerDomainEvent,
} from '../services/serverEventService.js';

const HEARTBEAT_MS = 15_000;
const RETRY_MS = 3_000;

function writeEvent(res: express.Response, event: ServerDomainEvent) {
  res.write(`id: ${event.id}\n`);
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

function writeControl(res: express.Response, type: 'stream.ready' | 'stream.reset', reason: string) {
  res.write(`event: ${type}\n`);
  res.write(`data: ${JSON.stringify({ v: 1, type, at: new Date().toISOString(), reason })}\n\n`);
}

export function registerEventRoutes(app: express.Express) {
  app.get('/api/events', (req, res) => {
    let subscription: ReturnType<typeof subscribeServerEvents> | null = null;
    try {
      subscription = subscribeServerEvents((event) => writeEvent(res, event));
    } catch (error) {
      if (error instanceof ServerEventCapacityError) {
        return res.status(503).json({
          error: {
            code: error.code,
            message: error.message,
            retryable: true,
          },
        });
      }
      throw error;
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    res.write(`retry: ${RETRY_MS}\n\n`);

    const headerLastEventId = req.get('Last-Event-ID');
    const queryLastEventId = typeof req.query.lastEventId === 'string' ? req.query.lastEventId : undefined;
    const replay = getServerEventReplay(headerLastEventId || queryLastEventId);
    if (replay.resetRequired) {
      writeControl(res, 'stream.reset', 'replay-unavailable');
    } else {
      for (const event of replay.events) writeEvent(res, event);
      writeControl(res, 'stream.ready', replay.events.length > 0 ? 'replayed' : 'connected');
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, HEARTBEAT_MS);
    heartbeat.unref?.();

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      subscription?.unsubscribe();
      subscription = null;
    };
    req.once('close', cleanup);
    res.once('close', cleanup);
    res.once('finish', cleanup);
    return undefined;
  });
}
