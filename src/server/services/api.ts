import type express from 'express';

export interface DevFlowErrorPayload {
  code: string;
  message: string;
  details?: unknown;
  retryable: boolean;
  affectedId?: string;
  correlationId?: string;
}

export class DevFlowApiError extends Error {
  status: number;
  payload: DevFlowErrorPayload;

  constructor(status: number, payload: Omit<DevFlowErrorPayload, 'correlationId'>) {
    super(payload.message);
    this.status = status;
    this.payload = { ...payload };
  }
}

export function createCorrelationId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;
}

export function getCorrelationId(req: express.Request, res?: express.Response) {
  const existing = res?.locals?.correlationId || req.headers['x-correlation-id'];
  if (typeof existing === 'string' && existing.trim()) return existing.trim();
  return createCorrelationId('req');
}

export function createApiError(status: number, code: string, message: string, options?: {
  [key: string]: unknown;
  details?: unknown;
  retryable?: boolean;
  affectedId?: string;
}) {
  return new DevFlowApiError(status, {
    code,
    message,
    details: options?.details,
    retryable: options?.retryable ?? false,
    affectedId: options?.affectedId,
  });
}

export function normalizeUnknownError(error: unknown, correlationId?: string): { status: number; error: DevFlowErrorPayload } {
  if (error instanceof DevFlowApiError) {
    return {
      status: error.status,
      error: { ...error.payload, correlationId: correlationId || error.payload.correlationId },
    };
  }

  if (error && typeof error === 'object' && 'message' in error) {
    return {
      status: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: String((error as { message: unknown }).message || 'Unexpected error'),
        retryable: false,
        correlationId,
      },
    };
  }

  return {
    status: 500,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Unexpected error',
      retryable: false,
      correlationId,
    },
  };
}

export function sendApiError(res: express.Response, error: unknown, fallbackStatus = 500) {
  const correlationId = res.locals?.correlationId;
  const normalized = normalizeUnknownError(error, correlationId);
  return res.status(normalized.status || fallbackStatus).json({ error: normalized.error });
}

export function installApiRequestContext(app: express.Express) {
  app.use('/api', (req, res, next) => {
    const correlationId = getCorrelationId(req, res);
    const startedAt = Date.now();
    res.locals.correlationId = correlationId;
    res.locals.startedAt = startedAt;
    res.setHeader('x-correlation-id', correlationId);

    const originalJson = res.json.bind(res);
    res.json = ((body: any) => {
      if (res.statusCode >= 400 && body && typeof body === 'object') {
        if (typeof body.error === 'string') {
          body = {
            ...body,
            error: {
              code: String(body.code || 'REQUEST_FAILED'),
              message: body.error,
              details: body.details,
              retryable: res.statusCode >= 500,
              affectedId: body.affectedId || body.taskId || body.projectId,
              correlationId,
            },
          };
        } else if (body.error && typeof body.error === 'object' && !body.error.correlationId) {
          body = {
            ...body,
            error: {
              ...body.error,
              retryable: body.error.retryable ?? res.statusCode >= 500,
              correlationId,
            },
          };
        }
      }

      return originalJson(body);
    }) as typeof res.json;

    res.on('finish', () => {
      const body = req.body as any;
      const query = req.query as any;
      const params = req.params as any;
      const taskId = params?.id || params?.taskId || body?.taskId || query?.taskId || '';
      const projectId = params?.projectId || body?.projectId || query?.projectId || '';
      console.log(
        `[api] cid=${correlationId} op=${req.method} ${req.path} status=${res.statusCode} durationMs=${Date.now() - startedAt} taskId=${taskId || '-'} projectId=${projectId || '-'}`
      );
    });

    next();
  });
}
