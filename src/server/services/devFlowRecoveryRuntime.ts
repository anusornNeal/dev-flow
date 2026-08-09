import type { AppState } from '../types';
import { createDevFlowRecoveryAdapters } from './devFlowRecoveryAdapters.js';
import { executeWithToolRecovery } from './toolRecoveryEngine.js';
import { getToolRecoveryPolicy } from './toolRecoveryPolicy.js';

function structuredResultErrorCode(value: any) {
  const direct = value?.ok === false ? value?.code || value?.error?.code : undefined;
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  if (Array.isArray(value?.files)) {
    const batch = value.files.find((entry: any) => entry?.error?.code === 'BATCH_BYTE_LIMIT');
    if (batch) return 'BATCH_BYTE_LIMIT';
  }
  return undefined;
}

function codedError(code: string) {
  return Object.assign(new Error(code), { code });
}

export async function executeRecoveryAwareTool<TResult>(
  state: AppState,
  toolName: string,
  args: Record<string, any>,
  attempt: (payload: Record<string, any>) => TResult | Promise<TResult>,
) {
  let structuredFailure: any = null;
  let thrownFailure: any = null;
  const recovery = await executeWithToolRecovery<Record<string, any>, TResult>({
    initialPayload: args,
    attempt: async (payload) => {
      try {
        const value: any = await attempt(payload);
        const code = structuredResultErrorCode(value);
        if (code) {
          const policy = getToolRecoveryPolicy(code);
          if (policy.category !== 'terminal') {
            structuredFailure = value;
            throw codedError(code);
          }
        }
        return value as TResult;
      } catch (error) {
        if (!structuredFailure) thrownFailure = error;
        throw error;
      }
    },
    adapters: createDevFlowRecoveryAdapters(state, toolName),
  });

  if (recovery.ok) {
    if (recovery.recovery?.outcome === 'not-needed') return recovery.value;
    if (recovery.value && typeof recovery.value === 'object' && !Array.isArray(recovery.value)) {
      return { ...(recovery.value as any), recoveryEngine: recovery.recovery } as TResult;
    }
    return { value: recovery.value, recoveryEngine: recovery.recovery } as TResult;
  }

  if (structuredFailure && typeof structuredFailure === 'object') {
    return {
      ...structuredFailure,
      recoveryEngine: recovery.recovery,
      ...(recovery.recovery?.outcome === 'preview-ready' ? { freshPreview: recovery.recovery.preview } : {}),
    } as TResult;
  }

  if (thrownFailure && typeof thrownFailure === 'object' && String((thrownFailure as any).code || '') === String(recovery.error?.code || '')) {
    (thrownFailure as any).recoveryEngine = recovery.recovery;
    throw thrownFailure;
  }

  throw Object.assign(new Error(recovery.error?.guidance || 'Tool recovery failed.'), {
    code: recovery.error?.code || 'RECOVERY_FAILED',
    recoveryEngine: recovery.recovery,
  });
}
