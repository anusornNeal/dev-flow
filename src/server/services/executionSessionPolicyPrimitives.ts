import { getExecutionSessionById, type ExecutionSessionRecord } from '../repositories/executionSessionRepository.js';

export function executionSessionError(code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { code?: string; details?: unknown };
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

export function requireExecutionSession(id: string) {
  const session = getExecutionSessionById(id);
  if (!session) throw executionSessionError('EXECUTION_SESSION_NOT_FOUND', `Execution session '${id}' was not found.`);
  return session;
}

export function assertExecutionSessionActive(session: ExecutionSessionRecord) {
  if (session.status !== 'active') {
    throw executionSessionError('EXECUTION_SESSION_TERMINAL', `Execution session '${session.id}' is terminal (${session.status}) and cannot mutate as active.`);
  }
}

export function readExecutionStringMetadata(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  return typeof value === 'string' && value ? value : undefined;
}
