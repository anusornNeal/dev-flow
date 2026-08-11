export interface UiPreviewGcInventoryObject {
  objectHash: string;
  createdAt: string | number | Date;
  rawBytes?: number;
  storedBytes?: number;
}

export interface UiPreviewGcMetricBucket {
  count: number;
  rawBytes: number;
  storedBytes: number;
}

export interface UiPreviewObjectGcPlan {
  generatedAt: string;
  graceCutoffAt: string;
  referenced: string[];
  unreachable: string[];
  protected: string[];
  deletable: string[];
  metrics: {
    referenced: UiPreviewGcMetricBucket;
    unreachable: UiPreviewGcMetricBucket;
    protected: UiPreviewGcMetricBucket;
    deletable: UiPreviewGcMetricBucket;
  };
}

export interface UiPreviewObjectGcInput {
  roots: Iterable<string>;
  inventory: Iterable<UiPreviewGcInventoryObject>;
  deleteObject?: (objectHash: string) => void | Promise<void>;
  now?: () => string | number | Date;
  gracePeriodMs?: number;
  apply?: boolean;
}

export interface UiPreviewObjectGcResult {
  mode: 'dry-run' | 'apply';
  plan: UiPreviewObjectGcPlan;
  deletions: {
    attempted: number;
    succeeded: string[];
    failed: Array<{ objectHash: string; error: string }>;
  };
}

export class UiPreviewObjectGcError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'UiPreviewObjectGcError';
    this.code = code;
  }
}

export const DEFAULT_UI_PREVIEW_GC_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

const OBJECT_HASH_PATTERN = /^[0-9a-f]{64}$/;

type NormalizedInventoryObject = {
  objectHash: string;
  createdAtMs: number;
  rawBytes?: number;
  storedBytes?: number;
};

function fail(code: string, message: string): never {
  throw new UiPreviewObjectGcError(code, message);
}

function assertHash(value: unknown, label: string) {
  if (typeof value !== 'string' || !OBJECT_HASH_PATTERN.test(value)) {
    fail('UI_PREVIEW_GC_INVALID_HASH', `${label} must be exactly 64 lowercase hexadecimal characters.`);
  }
  return value;
}

function toTimestamp(value: unknown, label: string) {
  const timestamp = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    fail('UI_PREVIEW_GC_INVALID_TIMESTAMP', `${label} must be a valid timestamp.`);
  }
  return timestamp;
}

function validateOptionalBytes(value: unknown, label: string) {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('UI_PREVIEW_GC_INVALID_BYTES', `${label} must be a non-negative integer when provided.`);
  }
  return value;
}

function normalizeGracePeriod(value: unknown) {
  const gracePeriodMs = value === undefined ? DEFAULT_UI_PREVIEW_GC_GRACE_PERIOD_MS : value;
  if (typeof gracePeriodMs !== 'number' || !Number.isFinite(gracePeriodMs) || gracePeriodMs < 0) {
    fail('UI_PREVIEW_GC_INVALID_GRACE_PERIOD', 'gracePeriodMs must be a finite non-negative number.');
  }
  return gracePeriodMs;
}

function metricsFor(hashes: string[], inventory: Map<string, NormalizedInventoryObject>): UiPreviewGcMetricBucket {
  let rawBytes = 0;
  let storedBytes = 0;
  for (const hash of hashes) {
    const item = inventory.get(hash);
    if (!item) continue;
    rawBytes += item.rawBytes ?? 0;
    storedBytes += item.storedBytes ?? 0;
  }
  return { count: hashes.length, rawBytes, storedBytes };
}

function normalizeInventory(items: Iterable<UiPreviewGcInventoryObject>) {
  const inventory = new Map<string, NormalizedInventoryObject>();
  let index = 0;
  for (const item of items) {
    const objectHash = assertHash(item?.objectHash, `inventory[${index}].objectHash`);
    if (inventory.has(objectHash)) {
      fail('UI_PREVIEW_GC_DUPLICATE_INVENTORY_HASH', `Inventory contains duplicate object hash ${objectHash}.`);
    }
    inventory.set(objectHash, {
      objectHash,
      createdAtMs: toTimestamp(item?.createdAt, `inventory[${index}].createdAt`),
      rawBytes: validateOptionalBytes(item?.rawBytes, `inventory[${index}].rawBytes`),
      storedBytes: validateOptionalBytes(item?.storedBytes, `inventory[${index}].storedBytes`),
    });
    index += 1;
  }
  return inventory;
}

export function planUiPreviewObjectGc(input: Omit<UiPreviewObjectGcInput, 'deleteObject' | 'apply'>): UiPreviewObjectGcPlan {
  const nowValue = input.now ? input.now() : Date.now();
  const nowMs = toTimestamp(nowValue, 'now()');
  const gracePeriodMs = normalizeGracePeriod(input.gracePeriodMs);
  const graceCutoffMs = nowMs - gracePeriodMs;
  const inventory = normalizeInventory(input.inventory);

  const rootSet = new Set<string>();
  let rootIndex = 0;
  for (const root of input.roots) {
    const objectHash = assertHash(root, `roots[${rootIndex}]`);
    if (!inventory.has(objectHash)) {
      fail('UI_PREVIEW_GC_UNKNOWN_ROOT', `Root object ${objectHash} is not present in inventory.`);
    }
    rootSet.add(objectHash);
    rootIndex += 1;
  }

  const referenced = [...rootSet].sort();
  const unreachable = [...inventory.keys()].filter((hash) => !rootSet.has(hash)).sort();
  const protectedHashes: string[] = [];
  const deletable: string[] = [];

  for (const hash of unreachable) {
    const item = inventory.get(hash)!;
    if (item.createdAtMs < graceCutoffMs) deletable.push(hash);
    else protectedHashes.push(hash);
  }

  return {
    generatedAt: new Date(nowMs).toISOString(),
    graceCutoffAt: new Date(graceCutoffMs).toISOString(),
    referenced,
    unreachable,
    protected: protectedHashes,
    deletable,
    metrics: {
      referenced: metricsFor(referenced, inventory),
      unreachable: metricsFor(unreachable, inventory),
      protected: metricsFor(protectedHashes, inventory),
      deletable: metricsFor(deletable, inventory),
    },
  };
}

function errorMessage(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export async function runUiPreviewObjectGc(input: UiPreviewObjectGcInput): Promise<UiPreviewObjectGcResult> {
  const plan = planUiPreviewObjectGc({
    roots: input.roots,
    inventory: input.inventory,
    now: input.now,
    gracePeriodMs: input.gracePeriodMs,
  });
  const mode = input.apply === true ? 'apply' : 'dry-run';
  const deletions: UiPreviewObjectGcResult['deletions'] = {
    attempted: 0,
    succeeded: [],
    failed: [],
  };

  if (mode === 'dry-run') return { mode, plan, deletions };
  if (typeof input.deleteObject !== 'function') {
    fail('UI_PREVIEW_GC_DELETE_CALLBACK_REQUIRED', 'deleteObject is required when apply=true.');
  }

  const exactPlan = new Set(plan.deletable);
  for (const objectHash of plan.deletable) {
    if (!exactPlan.has(objectHash)) {
      fail('UI_PREVIEW_GC_PLAN_VIOLATION', `Refusing to delete ${objectHash} because it is not in the computed plan.`);
    }
    deletions.attempted += 1;
    try {
      await input.deleteObject(objectHash);
      deletions.succeeded.push(objectHash);
    } catch (error) {
      deletions.failed.push({ objectHash, error: errorMessage(error) });
    }
  }

  return { mode, plan, deletions };
}
