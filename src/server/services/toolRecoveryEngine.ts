import crypto from 'node:crypto';
import { evaluateRecoveryAttempt, getToolRecoveryPolicy, type RecoveryAttemptHistory } from './toolRecoveryPolicy.js';

export type RecoveryEngineStep = {
  code: string;
  strategy: string;
  outcome: 'executed' | 'stopped';
};

export type RecoveryAdapters<TPayload, TResult> = {
  splitBatch?: (payload: TPayload, error: unknown) => Promise<{ chunks: TPayload[]; combine?: (values: TResult[]) => TResult }>;
  refreshContext?: (payload: TPayload, error: unknown) => Promise<TPayload>;
  waitResult?: (payload: TPayload, error: unknown, options: { waitMs: number }) => Promise<TResult | { ready: boolean; value?: TResult }>;
  fallbackSearch?: (payload: TPayload, error: unknown) => Promise<TPayload>;
  refreshPreview?: (payload: TPayload, error: unknown) => Promise<any>;
};

export type RecoveryEngineInput<TPayload, TResult> = {
  initialPayload: TPayload;
  attempt: (payload: TPayload) => Promise<TResult>;
  adapters?: RecoveryAdapters<TPayload, TResult>;
  classifyError?: (error: unknown) => string;
  fingerprint?: (payload: TPayload) => string;
  maxSteps?: number;
  waitMs?: number;
};

type RecoveryEvidence = {
  outcome: string;
  steps: RecoveryEngineStep[];
  externalAgentCalls: number;
  internalAttempts: number;
  manualRecoveryCallsAvoided: number;
  requiresExplicitApply?: boolean;
  preview?: any;
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

function defaultFingerprint(payload: unknown) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex').slice(0, 24);
}

function classifyErrorCode(error: any) {
  return String(
    error?.code
    || error?.error?.code
    || error?.payload?.error?.code
    || error?.body?.error?.code
    || 'UNKNOWN_ERROR',
  ).trim().toUpperCase() || 'UNKNOWN_ERROR';
}

function compactError(code: string) {
  const policy = getToolRecoveryPolicy(code);
  return { code: policy.code, category: policy.category, strategy: policy.strategy, guidance: policy.guidance };
}

export async function executeWithToolRecovery<TPayload, TResult>(input: RecoveryEngineInput<TPayload, TResult>): Promise<any> {
  const adapters = input.adapters || {};
  const classify = input.classifyError || classifyErrorCode;
  const fingerprint = input.fingerprint || defaultFingerprint;
  const maxSteps = Math.max(1, Math.min(10, Math.floor(Number(input.maxSteps || 3))));
  const waitMs = Math.max(1, Math.min(30_000, Math.floor(Number(input.waitMs || 5_000))));
  const history: RecoveryAttemptHistory[] = [];
  const steps: RecoveryEngineStep[] = [];
  let internalAttempts = 0;

  const evidence = (outcome: string, extra: Partial<RecoveryEvidence> = {}): RecoveryEvidence => ({
    outcome,
    steps: [...steps],
    externalAgentCalls: 0,
    internalAttempts,
    manualRecoveryCallsAvoided: steps.filter((step) => step.outcome === 'executed').length,
    ...extra,
  });

  const stop = (code: string, outcome: string, extra: Partial<RecoveryEvidence> = {}) => ({
    ok: false as const,
    error: compactError(code),
    recovery: evidence(outcome, extra),
  });

  const runAdapter = async <T>(fn: () => T | Promise<T>) => {
    try {
      return { ok: true as const, value: await fn() };
    } catch (adapterError) {
      const adapterCode = classify(adapterError);
      const adapterPolicy = getToolRecoveryPolicy(adapterCode);
      return {
        ok: false as const,
        result: stop(adapterCode, adapterPolicy.category === 'decision-required' ? 'decision-required' : 'adapter-failed'),
      };
    }
  };

  const run = async (payload: TPayload): Promise<any> => {
    try {
      internalAttempts += 1;
      const value = await input.attempt(payload);
      return {
        ok: true as const,
        value,
        recovery: evidence(steps.length > 0 ? 'recovered' : 'not-needed'),
      };
    } catch (error) {
      const code = classify(error);
      const payloadFingerprint = fingerprint(payload);
      const decision = evaluateRecoveryAttempt({ code, payloadFingerprint, history, maxSteps });

      if (decision.decision === 'decision') {
        steps.push({ code: decision.code, strategy: decision.strategy, outcome: 'stopped' });
        return stop(decision.code, 'decision-required');
      }
      if (decision.decision === 'stop') {
        return stop(decision.code, decision.reason);
      }

      const recordStep = () => {
        history.push({ code: decision.code, strategy: decision.strategy, payloadFingerprint });
        steps.push({ code: decision.code, strategy: decision.strategy, outcome: 'executed' });
      };

      if (decision.strategy === 'split-batch') {
        if (!adapters.splitBatch) return stop(decision.code, 'adapter-unavailable');
        const splitResult = await runAdapter(() => adapters.splitBatch!(payload, error));
        if (!splitResult.ok) return splitResult.result;
        const split = splitResult.value;
        const chunks = Array.isArray(split?.chunks) ? split.chunks : [];
        if (chunks.length < 2) return stop(decision.code, 'invalid-recovery-output');
        if (chunks.some((chunk) => fingerprint(chunk) === payloadFingerprint)) return stop(decision.code, 'loop-detected');
        recordStep();
        const values: TResult[] = [];
        for (const chunk of chunks) {
          const result = await run(chunk);
          if (!result.ok) return result;
          values.push(result.value);
        }
        const combineResult = await runAdapter(() => split.combine ? split.combine(values) : (values as unknown as TResult));
        if (!combineResult.ok) return combineResult.result;
        return { ok: true as const, value: combineResult.value, recovery: evidence('recovered') };
      }

      if (decision.strategy === 'refresh-context') {
        if (!adapters.refreshContext) return stop(decision.code, 'adapter-unavailable');
        const refreshResult = await runAdapter(() => adapters.refreshContext!(payload, error));
        if (!refreshResult.ok) return refreshResult.result;
        const refreshed = refreshResult.value;
        if (fingerprint(refreshed) === payloadFingerprint) {
          recordStep();
          return stop(decision.code, 'loop-detected');
        }
        recordStep();
        return run(refreshed);
      }

      if (decision.strategy === 'wait-result') {
        if (!adapters.waitResult) return stop(decision.code, 'adapter-unavailable');
        recordStep();
        const waitResult = await runAdapter(() => adapters.waitResult!(payload, error, { waitMs }));
        if (!waitResult.ok) return waitResult.result;
        const waited = waitResult.value;
        if (waited && typeof waited === 'object' && 'ready' in waited) {
          if ((waited as any).ready !== true) return stop(decision.code, 'wait-timeout');
          return { ok: true as const, value: (waited as any).value, recovery: evidence('recovered') };
        }
        return { ok: true as const, value: waited as TResult, recovery: evidence('recovered') };
      }

      if (decision.strategy === 'fallback-search') {
        if (!adapters.fallbackSearch) return stop(decision.code, 'adapter-unavailable');
        const fallbackResult = await runAdapter(() => adapters.fallbackSearch!(payload, error));
        if (!fallbackResult.ok) return fallbackResult.result;
        const fallback = fallbackResult.value;
        if (fingerprint(fallback) === payloadFingerprint) {
          recordStep();
          return stop(decision.code, 'loop-detected');
        }
        recordStep();
        return run(fallback);
      }

      if (decision.strategy === 'refresh-source-repreview' || decision.strategy === 'refresh-base-repreview') {
        if (!adapters.refreshPreview) return stop(decision.code, 'adapter-unavailable');
        recordStep();
        const previewResult = await runAdapter(() => adapters.refreshPreview!(payload, error));
        if (!previewResult.ok) return previewResult.result;
        return stop(decision.code, 'preview-ready', {
          preview: previewResult.value,
          requiresExplicitApply: true,
        });
      }

      return stop(decision.code, 'unsupported-recovery-strategy');
    }
  };

  return run(input.initialPayload);
}
