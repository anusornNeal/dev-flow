import crypto from 'node:crypto';

export type VerificationResourceCostClass = 'low' | 'medium' | 'high';
export type VerificationResourceClass = 'fast' | 'heavy';
export type VerificationResourceSampleStatus = 'succeeded' | 'failed' | 'timed_out';
export type VerificationResourceConfidence = 'none' | 'low' | 'medium' | 'high';

export type VerificationResourceProfileDescriptor = {
  repositoryKey: string;
  semanticKey: string;
  machineKey: string;
  cost: VerificationResourceCostClass;
  verificationClass: VerificationResourceClass;
  sharedResources: string[];
};

export type VerificationResourceVector = {
  cpuRatio: number;
  memoryBytes: number;
  durationMs: number;
  processCount: number;
};

export type VerificationResourcePrediction = {
  profileKey: string;
  machineKey: string;
  sharedResources: string[];
  expected: VerificationResourceVector;
  upperBound: VerificationResourceVector;
  sampleCount: number;
  successfulSampleCount: number;
  confidence: VerificationResourceConfidence;
};

export type VerificationResourceSample = {
  status: VerificationResourceSampleStatus;
  durationMs: number;
  cpuRatio?: number;
  memoryBytes?: number;
  processCount?: number;
  systemCpuRatio?: number;
  memoryPressureRatio?: number;
  treeAccounting?: boolean;
  predicted?: VerificationResourcePrediction;
  recordedAt?: number;
};

type StoredVerificationResourceSample = VerificationResourceSample & { recordedAt: number };

type VerificationResourceProfile = {
  descriptor: VerificationResourceProfileDescriptor;
  samples: StoredVerificationResourceSample[];
  updatedAt: number;
};

type RelativeErrorMetric = 'duration' | 'cpu' | 'memory';

const MAX_PROFILES = 256;
const MAX_SAMPLES_PER_PROFILE = 24;
const MAX_ERROR_SAMPLES = 256;
const MIN_LEARNING_SAMPLES = 3;
const RECENCY_DECAY = 0.78;
const OUTLIER_LOW_FACTOR = 0.5;
const OUTLIER_HIGH_FACTOR = 2.5;

const profiles = new Map<string, VerificationResourceProfile>();
const predictionErrors: Record<RelativeErrorMetric, number[]> = {
  duration: [],
  cpu: [],
  memory: [],
};
let predictionComparisons = 0;

const MIB = 1024 ** 2;
const COLD_START: Record<VerificationResourceCostClass, VerificationResourceVector> = {
  low: { cpuRatio: 0.25, memoryBytes: 256 * MIB, durationMs: 15_000, processCount: 2 },
  medium: { cpuRatio: 0.5, memoryBytes: 512 * MIB, durationMs: 45_000, processCount: 3 },
  high: { cpuRatio: 0.8, memoryBytes: 1024 * MIB, durationMs: 120_000, processCount: 5 },
};

function finiteNonNegative(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, numeric) : undefined;
}

function normalizeDescriptor(descriptor: VerificationResourceProfileDescriptor): VerificationResourceProfileDescriptor {
  return {
    repositoryKey: String(descriptor.repositoryKey || '').trim(),
    semanticKey: String(descriptor.semanticKey || '').trim(),
    machineKey: String(descriptor.machineKey || '').trim(),
    cost: descriptor.cost === 'low' || descriptor.cost === 'high' ? descriptor.cost : 'medium',
    verificationClass: descriptor.verificationClass === 'heavy' ? 'heavy' : 'fast',
    sharedResources: [...new Set((descriptor.sharedResources || []).map((item) => String(item || '').trim()).filter(Boolean))].sort(),
  };
}

export function buildVerificationResourceProfileKey(descriptor: VerificationResourceProfileDescriptor) {
  const normalized = normalizeDescriptor(descriptor);
  return crypto.createHash('sha256').update(JSON.stringify({
    repositoryKey: normalized.repositoryKey,
    semanticKey: normalized.semanticKey,
    machineKey: normalized.machineKey,
  })).digest('hex').slice(0, 32);
}

function coldStartVector(descriptor: VerificationResourceProfileDescriptor): VerificationResourceVector {
  const base = COLD_START[descriptor.cost] || COLD_START.medium;
  if (descriptor.verificationClass !== 'heavy' || descriptor.cost === 'high') return { ...base };
  return {
    cpuRatio: Math.max(base.cpuRatio, 0.7),
    memoryBytes: Math.max(base.memoryBytes, 768 * MIB),
    durationMs: Math.max(base.durationMs, 75_000),
    processCount: Math.max(base.processCount, 4),
  };
}

function median(values: number[]) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function clippedValues(values: number[]) {
  const center = median(values);
  if (center === undefined) return [];
  const low = center === 0 ? 0 : center * OUTLIER_LOW_FACTOR;
  const high = center === 0 ? Math.max(...values, 0) : center * OUTLIER_HIGH_FACTOR;
  return values.map((value) => Math.max(low, Math.min(high, value)));
}

function recencyWeighted(values: number[]) {
  if (values.length === 0) return undefined;
  let weighted = 0;
  let weights = 0;
  for (let index = 0; index < values.length; index += 1) {
    const age = values.length - index - 1;
    const weight = RECENCY_DECAY ** age;
    weighted += values[index] * weight;
    weights += weight;
  }
  return weights > 0 ? weighted / weights : undefined;
}

function learnedMetric(samples: StoredVerificationResourceSample[], selector: (sample: StoredVerificationResourceSample) => unknown) {
  const values = samples
    .map(selector)
    .map(finiteNonNegative)
    .filter((value): value is number => value !== undefined);
  if (values.length < MIN_LEARNING_SAMPLES) return undefined;
  const clipped = clippedValues(values);
  const expected = recencyWeighted(clipped);
  if (expected === undefined) return undefined;
  const clippedMax = Math.max(...clipped, expected);
  return {
    expected,
    upperBound: Math.max(expected * 1.35, clippedMax * 1.1),
  };
}

function roundVector(vector: VerificationResourceVector): VerificationResourceVector {
  return {
    cpuRatio: Math.max(0, Math.min(1, Math.round(vector.cpuRatio * 10_000) / 10_000)),
    memoryBytes: Math.max(0, Math.round(vector.memoryBytes)),
    durationMs: Math.max(1, Math.round(vector.durationMs)),
    processCount: Math.max(1, Math.round(vector.processCount)),
  };
}

function confidenceFor(successfulSampleCount: number): VerificationResourceConfidence {
  if (successfulSampleCount <= 0) return 'none';
  if (successfulSampleCount < 3) return 'low';
  if (successfulSampleCount < 6) return 'medium';
  return 'high';
}

function getProfile(profileKey: string) {
  const profile = profiles.get(profileKey);
  if (!profile) return undefined;
  profiles.delete(profileKey);
  profiles.set(profileKey, profile);
  return profile;
}

function pruneProfiles() {
  while (profiles.size > MAX_PROFILES) {
    const oldestKey = profiles.keys().next().value as string | undefined;
    if (!oldestKey) break;
    profiles.delete(oldestKey);
  }
}

function buildPrediction(descriptorInput: VerificationResourceProfileDescriptor, profile?: VerificationResourceProfile): VerificationResourcePrediction {
  const descriptor = normalizeDescriptor(descriptorInput);
  const profileKey = buildVerificationResourceProfileKey(descriptor);
  const successful = (profile?.samples || []).filter((sample) => sample.status === 'succeeded');
  const authoritativeTreeSamples = successful.filter((sample) => sample.treeAccounting === true);
  const fallback = coldStartVector(descriptor);
  const cpu = learnedMetric(successful, (sample) => sample.cpuRatio ?? sample.systemCpuRatio);
  const memory = learnedMetric(authoritativeTreeSamples, (sample) => sample.memoryBytes);
  const duration = learnedMetric(successful, (sample) => sample.durationMs);
  const processCount = learnedMetric(authoritativeTreeSamples, (sample) => sample.processCount);
  const expected = roundVector({
    cpuRatio: cpu?.expected ?? fallback.cpuRatio,
    memoryBytes: memory?.expected ?? fallback.memoryBytes,
    durationMs: duration?.expected ?? fallback.durationMs,
    processCount: processCount?.expected ?? fallback.processCount,
  });
  const upperBound = roundVector({
    cpuRatio: Math.min(1, cpu?.upperBound ?? Math.max(expected.cpuRatio, fallback.cpuRatio) * 1.25),
    memoryBytes: memory?.upperBound ?? Math.max(expected.memoryBytes, fallback.memoryBytes) * 1.35,
    durationMs: duration?.upperBound ?? Math.max(expected.durationMs, fallback.durationMs) * 1.35,
    processCount: processCount?.upperBound ?? Math.max(expected.processCount, fallback.processCount) * 1.25,
  });
  return {
    profileKey,
    machineKey: descriptor.machineKey,
    sharedResources: [...descriptor.sharedResources],
    expected,
    upperBound,
    sampleCount: profile?.samples.length || 0,
    successfulSampleCount: successful.length,
    confidence: confidenceFor(successful.length),
  };
}

export function predictVerificationResourceCost(descriptor: VerificationResourceProfileDescriptor): VerificationResourcePrediction {
  const profileKey = buildVerificationResourceProfileKey(descriptor);
  const profile = getProfile(profileKey);
  return buildPrediction(descriptor, profile);
}

function pushBounded(target: number[], value: number) {
  if (!Number.isFinite(value)) return;
  target.push(Math.max(0, value));
  if (target.length > MAX_ERROR_SAMPLES) target.splice(0, target.length - MAX_ERROR_SAMPLES);
}

function relativeError(predicted: number | undefined, actual: number | undefined) {
  if (predicted === undefined || actual === undefined || !Number.isFinite(predicted) || !Number.isFinite(actual) || predicted <= 0) return undefined;
  return Math.abs(actual - predicted) / predicted;
}

function recordPredictionErrors(sample: StoredVerificationResourceSample) {
  if (!sample.predicted || sample.status !== 'succeeded') return;
  let compared = false;
  const duration = relativeError(sample.predicted.expected.durationMs, finiteNonNegative(sample.durationMs));
  const cpu = relativeError(sample.predicted.expected.cpuRatio, finiteNonNegative(sample.cpuRatio ?? sample.systemCpuRatio));
  const memory = sample.treeAccounting === true
    ? relativeError(sample.predicted.expected.memoryBytes, finiteNonNegative(sample.memoryBytes))
    : undefined;
  if (duration !== undefined) {
    pushBounded(predictionErrors.duration, duration);
    compared = true;
  }
  if (cpu !== undefined) {
    pushBounded(predictionErrors.cpu, cpu);
    compared = true;
  }
  if (memory !== undefined) {
    pushBounded(predictionErrors.memory, memory);
    compared = true;
  }
  if (compared) predictionComparisons += 1;
}

export function recordVerificationResourceSample(
  descriptorInput: VerificationResourceProfileDescriptor,
  sampleInput: VerificationResourceSample,
) {
  const descriptor = normalizeDescriptor(descriptorInput);
  const profileKey = buildVerificationResourceProfileKey(descriptor);
  const existing = getProfile(profileKey);
  const profile: VerificationResourceProfile = existing || { descriptor, samples: [], updatedAt: 0 };
  const sample: StoredVerificationResourceSample = {
    ...sampleInput,
    durationMs: Math.max(0, Number(sampleInput.durationMs) || 0),
    recordedAt: Number.isFinite(Number(sampleInput.recordedAt)) ? Number(sampleInput.recordedAt) : Date.now(),
  };
  profile.samples.push(sample);
  if (profile.samples.length > MAX_SAMPLES_PER_PROFILE) {
    profile.samples.splice(0, profile.samples.length - MAX_SAMPLES_PER_PROFILE);
  }
  profile.updatedAt = sample.recordedAt;
  profile.descriptor = descriptor;
  profiles.delete(profileKey);
  profiles.set(profileKey, profile);
  pruneProfiles();
  recordPredictionErrors(sample);
  return buildPrediction(descriptor, profile);
}

function average(values: number[]) {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

export function getVerificationResourceProfileDiagnostics() {
  const summaries = Array.from(profiles.entries()).map(([profileKey, profile]) => {
    const prediction = buildPrediction(profile.descriptor, profile);
    return {
      profileKey,
      machineKey: profile.descriptor.machineKey,
      verificationClass: profile.descriptor.verificationClass,
      cost: profile.descriptor.cost,
      sharedResources: [...profile.descriptor.sharedResources],
      sampleCount: prediction.sampleCount,
      successfulSampleCount: prediction.successfulSampleCount,
      authoritativeMemorySampleCount: profile.samples.filter((sample) => sample.status === 'succeeded' && sample.treeAccounting === true && finiteNonNegative(sample.memoryBytes) !== undefined).length,
      confidence: prediction.confidence,
      expected: prediction.expected,
      upperBound: prediction.upperBound,
      updatedAt: profile.updatedAt,
    };
  });
  const failedSamples = Array.from(profiles.values()).reduce(
    (sum, profile) => sum + profile.samples.filter((sample) => sample.status !== 'succeeded').length,
    0,
  );
  return {
    profileCount: summaries.length,
    profiles: summaries,
    retainedSamples: summaries.reduce((sum, profile) => sum + profile.sampleCount, 0),
    failedSamples,
    predictionComparisons,
    meanAbsoluteRelativeError: {
      duration: average(predictionErrors.duration),
      cpu: average(predictionErrors.cpu),
      memory: average(predictionErrors.memory),
    },
    retention: {
      maxProfiles: MAX_PROFILES,
      maxSamplesPerProfile: MAX_SAMPLES_PER_PROFILE,
    },
  };
}

export function clearVerificationResourceProfilesForTests() {
  profiles.clear();
  predictionErrors.duration.length = 0;
  predictionErrors.cpu.length = 0;
  predictionErrors.memory.length = 0;
  predictionComparisons = 0;
}
