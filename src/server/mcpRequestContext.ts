import { AsyncLocalStorage } from 'node:async_hooks';

const requestSignalStorage = new AsyncLocalStorage<AbortSignal>();

export function runMcpRequestScope<T>(signal: AbortSignal, operation: () => Promise<T>) {
  return requestSignalStorage.run(signal, operation);
}

export function getMcpRequestSignal() {
  return requestSignalStorage.getStore();
}
