export class ApiError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly correlationId: string;

  constructor(code: string, message: string, retryable: boolean, correlationId: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.retryable = retryable;
    this.correlationId = correlationId;
  }
}

function newCorrelationId(): string {
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function parseBody(response: Response): Promise<unknown> {
  const ct = response.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return response.json().catch(() => null);
  }
  return response.text();
}

export interface ApiResult<T> {
  data: T;
  correlationId: string;
  durationMs: number;
}

export const apiClient = {
  async fetchJson<T>(method: string, path: string, body?: unknown): Promise<ApiResult<T>> {
    const correlationId = newCorrelationId();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'x-correlation-id': correlationId,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const startedAt = Date.now();
    const response = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const parsed = await parseBody(response);
    const durationMs = Date.now() - startedAt;
    const responseCorrelationId = response.headers.get('x-correlation-id') || correlationId;

    if (!response.ok) {
      const err =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as { error: { code: string; message: string; retryable?: boolean; correlationId?: string } }).error
          : {
              code: 'HTTP_ERROR',
              message: typeof parsed === 'string' ? parsed : `HTTP ${response.status}`,
              retryable: response.status >= 500,
              correlationId: responseCorrelationId,
            };
      throw new ApiError(
        err.code,
        err.message,
        Boolean(err.retryable),
        err.correlationId || responseCorrelationId,
      );
    }

    return { data: parsed as T, correlationId: responseCorrelationId, durationMs };
  },
};

export const apiGet = <T>(path: string) => apiClient.fetchJson<T>('GET', path);
export const apiPost = <T>(path: string, body?: unknown) => apiClient.fetchJson<T>('POST', path, body);
export const apiPut = <T>(path: string, body?: unknown) => apiClient.fetchJson<T>('PUT', path, body);
export const apiDelete = <T>(path: string) => apiClient.fetchJson<T>('DELETE', path);
